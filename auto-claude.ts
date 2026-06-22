import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

// @xterm/headless ships a CJS bundle whose named exports Node's ESM loader can't
// statically detect, so we pull Terminal in via require() (this project runs
// under tsx). The cast restores the proper types from the package typings.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

// ==========================================
// CLI ARGS
// ==========================================
// Debug logging is opt-in via a flag (no env var). Pass --debug or -d.
const DEBUG: boolean = process.argv.includes('--debug') || process.argv.includes('-d');

// ==========================================
// CONFIG
// ==========================================
// How often we snapshot the rendered screen (and run limit detection on it).
const SCREEN_CAPTURE_INTERVAL_MS: number = 2000;
const LOG_FILE: string = path.join(process.cwd(), 'claude-auto.log');

// When this substring is on screen the user is scrolled up through history
// (it's the "(ctrl+End) ↓" jump-to-bottom hint). What we read in that state is
// stale scrollback, so we skip detection entirely.
const SCROLL_INDICATOR: string = ') ↓';

// After a candidate limit we type "continue" and listen to Claude's output for
// this long; if the limit text re-appears it's real, otherwise it was a ghost.
const VERIFY_LISTEN_MS: number = 1000;

// Safety margin added on top of the parsed reset time before we resume.
const WAIT_BUFFER_MS: number = 60 * 1000;

// A reset we've already counted down to is ignored if it shows up again within
// this window (a stale banner re-appearing after we resume). After it, the same
// clock time is a genuinely new day's limit and is allowed to trigger again.
const REPEAT_LIMIT_WINDOW_MS: number = 19 * 60 * 60 * 1000;

// Ctrl-U clears the input line in Claude Code; the draft can wrap, so we fire it
// a few times to wipe the whole composer before typing our own command.
const CLEAR_INPUT_SEQUENCE: string = '\x15'.repeat(8);

// Claude sometimes offers a "Stop and wait for limit to reset" menu; we select it
// (press Enter) so the session parks until reset. Wait briefly so the menu has
// fully rendered, then ignore it for a grace period so the redraw doesn't make
// us press Enter twice.
const MENU_PROMPT_TEXT: string = 'stop and wait for limit to reset';
const MENU_ENTER_DELAY_MS: number = 2000;
const MENU_GRACE_MS: number = 5000;

// Anchored on "hit your session limit" so the percentage early-warning doesn't
// trip it. Time is lenient: optional minutes, optional space, any case am/pm.
const limitRegex: RegExp = /hit your session limit[\s\S]{0,80}?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// Escape-sequence strippers so the verify buffer is matched as plain text:
// CSI / Fe sequences (colours, cursor moves) and OSC sequences (title sets).
const ansiRegex: RegExp = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const oscRegex: RegExp = /\x1b][\s\S]*?(?:\x07|\x1b\\)/g;

function log(msg: string): void {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        /* logging must never crash the wrapper */
    }
}

// ==========================================
// SPAWN CLAUDE
// ==========================================
const cols: number = process.stdout.columns || 80;
const rows: number = process.stdout.rows || 24;

const shell = os.platform() === 'win32' ? 'cmd.exe' : 'claude';
const args = os.platform() === 'win32' ? ['/c', 'claude'] : [];

const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    useConpty: true,
    // Use the standalone conpty.dll bundled with node-pty for better redraw
    // fidelity than the older in-box Windows ConPTY.
    useConptyDll: true
});

// A headless terminal mirrors Claude's TUI so we can read the *rendered* screen
// (the grid of characters the user actually sees) instead of the raw escape
// sequence stream. node-pty feeds it; we never display it.
// allowProposedApi is required to read `term.buffer` in this xterm version.
const term = new Terminal({ cols, rows, allowProposedApi: true });

// ==========================================
// DETECTION STATE
// ==========================================
let isWaiting: boolean = false;     // a confirmed limit countdown is running
let isVerifying: boolean = false;   // inside the post-"continue" listen window
let isHandlingMenu: boolean = false; // selecting the wait-for-reset menu
let verifyBuffer: string = '';     // output collected during verification
let countdownInterval: NodeJS.Timeout | null = null;
let lastResetMinutes: number | null = null; // reset (minutes-of-day) of last countdown
let lastFoundAt: number = 0;                 // wall-clock time we started that countdown
let captureInterval: NodeJS.Timeout | null = null;
let currentScreen: string = '';

// ==========================================
// I/O WIRING
// ==========================================
process.stdout.on('resize', () => {
    const c: number = process.stdout.columns || cols;
    const r: number = process.stdout.rows || rows;
    ptyProcess.resize(c, r);
    term.resize(c, r);
});

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
process.stdin.resume();

// Forward everything the user types straight to Claude.
process.stdin.on('data', (data: string) => {
    ptyProcess.write(data);
});

// Forward Claude's output to the real terminal and mirror it into the headless
// terminal. While verifying a limit, also collect the output (stripped of escape
// sequences) so we can scan it for the limit text re-appearing.
ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    term.write(data);
    if (isVerifying) {
        verifyBuffer += data.replace(oscRegex, '').replace(ansiRegex, '');
    }
});

// ==========================================
// SCREEN CAPTURE
// ==========================================
// Read the current visible screen out of the headless terminal's buffer: the
// `rows` lines starting at baseY (the top of the bottommost page).
function captureScreen(): string {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row++) {
        const line = buffer.getLine(buffer.baseY + row);
        lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
}

// ==========================================
// CLEANUP / TEARDOWN
// ==========================================
let cleanedUp = false;
function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        // Pop the saved window title back off the terminal's stack.
        try { process.stdout.write('\x1b[23;0t'); } catch { /* terminal already gone */ }
    }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* terminal already gone */ }
}

process.on('exit', cleanup);
// In raw mode Ctrl-C is forwarded to Claude as \x03, so these handlers only fire
// for out-of-band signals — they won't swallow the user's Ctrl-C.
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    cleanup();
    process.exit(exitCode);
});

// ==========================================
// MAIN PROCESS
// ==========================================

function main(): void {
    log('===== START =====');
    // Capture the screen state every x seconds
    captureInterval = setInterval(() => {
        // Already handling a limit (waiting it out or mid-verification) — do nothing.
        if (isWaiting || isVerifying || isHandlingMenu) return;
        currentScreen = captureScreen();
        onScreenCapture();
    }, SCREEN_CAPTURE_INTERVAL_MS);
}
main();

function onScreenCapture(): void {
    log('===== screen =====\n' + currentScreen + '\n===== end screen =====');
    detectLimit(currentScreen);
}

// ==========================================
// LIMIT DETECTION
// ==========================================
// Parse a limit match's reset clock time into minutes-of-day (0–1439). Used both
// to identify a reset (for the repeat guard) and to schedule the countdown.
function resetMinutes(match: RegExpMatchArray): number {
    let hours: number = parseInt(match[1]!, 10);
    const minutes: number = match[2] ? parseInt(match[2], 10) : 0;
    const ampm: string = match[3]!.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

function detectLimit(screen: string): void {
    // Already handling a limit (waiting it out or mid-verification) — do nothing.
    if (isWaiting || isVerifying || isHandlingMenu) return;

    // Scrolled-up history is stale; ignore it.
    if (screen.includes(SCROLL_INDICATOR)) return;

    // Auto-select Claude's "Stop and wait for limit to reset" menu when shown.
    // While the menu is on screen we never run limit detection (it would type
    // "continue" into the menu), so handle it here and bail out.
    if (screen.toLowerCase().includes(MENU_PROMPT_TEXT)) {
        isHandlingMenu = true;
        log('Menu detected — selecting "Stop and wait for limit to reset"');
        setTimeout(() => {
            ptyProcess.write('\r');
            // Release after a grace period so a genuinely new menu can still
            // be handled later, but the redraw of this one can't re-trigger.
            setTimeout(() => { isHandlingMenu = false; }, MENU_GRACE_MS);
        }, MENU_ENTER_DELAY_MS);
        return;
    }

    const match = screen.match(limitRegex);
    if (!match) return;

    // Skip a reset we've already counted down to (a stale banner re-appearing
    // after we resumed), unless 23h have passed — by then the same clock time is
    // a new day's limit.
    if (lastResetMinutes !== null &&
        resetMinutes(match) === lastResetMinutes &&
        Date.now() - lastFoundAt < REPEAT_LIMIT_WINDOW_MS) {
        log('Same reset as last countdown — ignoring');
        return;
    }

    // Candidate limit on the live screen. Confirm it by typing "continue" and
    // listening for the limit to come back within VERIFY_LISTEN_MS.
    log('Possible session limit — typing "continue" to verify');
    isVerifying = true;
    verifyBuffer = '';
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + 'continue\r');

    setTimeout(() => {
        isVerifying = false;
        const confirm = verifyBuffer.match(limitRegex);
        log('Verify Buffer: ' + verifyBuffer);
        verifyBuffer = '';
        if (confirm) {
            log('Limit re-appeared after "continue" — confirmed real');
            startCountdown(confirm);
        } else {
            log('No limit after "continue" — treating as ghost, ignoring');
        }
    }, VERIFY_LISTEN_MS);
}

function startCountdown(match: RegExpMatchArray): void {
    isWaiting = true;

    // Remember this reset (and when we found it) so the same banner re-appearing
    // after we resume doesn't trigger a second countdown (see detectLimit).
    const minutesOfDay = resetMinutes(match);
    lastResetMinutes = minutesOfDay;
    lastFoundAt = Date.now();

    // Save the current window title so we can restore it after the countdown.
    process.stdout.write('\x1b[22;0t');

    const hours = Math.floor(minutesOfDay / 60);
    const minutes = minutesOfDay % 60;

    const now = new Date();
    let targetTimeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0).getTime();
    targetTimeMs += WAIT_BUFFER_MS;
    if (targetTimeMs < Date.now()) {
        targetTimeMs += 24 * 60 * 60 * 1000;
    }

    log(`Limit confirmed. Resuming at ${new Date(targetTimeMs).toLocaleString()}`);

    countdownInterval = setInterval(() => {
        const remainingMs = targetTimeMs - Date.now();

        if (remainingMs <= 0) {
            clearInterval(countdownInterval!);
            countdownInterval = null;
            isWaiting = false;
            // Restore the window title and resume the session.
            process.stdout.write('\x1b[23;0t');
            log('Timer elapsed — sending "continue" to resume');
            ptyProcess.write(CLEAR_INPUT_SEQUENCE + 'continue\r');
        } else {
            const totalSeconds = Math.floor(remainingMs / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            const timeStr = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
            process.stdout.write(`\x1b]0;⏳ Claude Resumes: ${timeStr}\x07`);
        }
    }, 1000);
}

