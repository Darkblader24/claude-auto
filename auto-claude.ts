#!/usr/bin/env node
import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

// ==========================================
// CLI ARGS
// ==========================================
// This wrapper is a drop-in replacement for `claude`: every argument we don't
// recognise is forwarded verbatim to the real CLI. Our own flags are namespaced
// with an `auto-` prefix so they can't collide with claude's (`claude --debug`
// is a real flag), and they are stripped before forwarding.
const WRAPPER_FLAGS: ReadonlySet<string> = new Set(['--auto-debug']);

// Debug logging is opt-in via a flag (no env var). Pass --auto-debug.
const DEBUG: boolean = process.argv.includes('--auto-debug');

// Everything after `node auto-claude.ts`, minus our own flags.
const forwardedArgs: string[] = process.argv.slice(2).filter(arg => !WRAPPER_FLAGS.has(arg));

// ==========================================
// CONFIG
// ==========================================

// Anchored on "hit your session limit" so the percentage early-warning doesn't
// trip it. Time is lenient: optional minutes, optional space, any case am/pm.
const limitRegex: RegExp = /hit your session limit[\s\S]{0,80}?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// Claude sometimes offers a "Stop and wait for limit to reset" menu; we select it
// (press Enter) so the session parks until reset. Wait briefly so the menu has
// fully rendered, then ignore it for a grace period so the redraw doesn't make
// us press Enter twice.
const MENU_PROMPT_TEXT: string = 'stop and wait for limit to reset';
const MENU_ENTER_DELAY_MS: number = 2000;
const MENU_GRACE_MS: number = 5000;

// When this substring is on screen the user is scrolled up through history
// (it's the "(ctrl+End) ↓" jump-to-bottom hint). What we read in that state is
// stale scrollback, so we skip detection entirely.
const SCROLL_INDICATOR: string = ') ↓';

// Resuming an old, large session makes Claude ask whether to summarise it first
// ("This session is 3h old and 150K tokens" → "Resume from summary
// (recommended)" / "Resume full session as-is" / "Don't ask me again"). That
// question is a select menu, so any Enter we send answers it — and the default
// choice compacts the conversation. Worse, the limit banner from the session
// we're resuming is usually still on screen behind it, so detection would fire
// right into the menu. While the question is up we type nothing at all.
// Matched against the first option's label: short enough not to wrap.
const RESUME_PROMPT_TEXT: string = 'resume from summary';

// To verify a candidate limit we send this probe message, then re-check the
// screen. It doubles as a marker: only limit text appearing *after* the most
// recent probe counts, so a stale banner above it is ignored.
const VERIFY_PROBE: string = 'continue';

// How long to wait after sending the probe before capturing the screen to check.
const VERIFY_DELAY_MS: number = 5000;
// Safety margin added on top of the parsed reset time before we resume.
const WAIT_BUFFER_MS: number = 60 * 1000;

// A reset we've already counted down to is ignored if it shows up again within
// this window (a stale banner re-appearing after we resume). After it, the same
// clock time is a genuinely new day's limit and is allowed to trigger again.
const REPEAT_LIMIT_WINDOW_MS: number = 19 * 60 * 60 * 1000;

// Ctrl-U clears the input line in Claude Code; the draft can wrap, so we fire it
// a few times to wipe the whole composer before typing our own command.
const CLEAR_INPUT_SEQUENCE: string = '\x15'.repeat(8);

// F4 cancels an in-progress countdown. Terminals send F4 either as the SS3
// sequence ESC O S or as the CSI form ESC [ 14 ~; we match both.
const F4_SEQUENCES: string[] = ['\x1bOS', '\x1b[14~'];

// How often we snapshot the rendered screen in debug mode (and run limit detection on it).
const SCREEN_CAPTURE_INTERVAL_MS: number = 2000;
const LOG_FILE: string = path.join(process.cwd(), 'claude-auto.log');

function log(msg: string): void {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        /* logging must never crash the wrapper */
    }
}

// ==========================================
// SELF-CALL GUARD
// ==========================================
// A shell alias (`alias claude=claude-auto`) can't reach us: aliases are never
// exported and we exec directly, not through a shell. But a *script* named
// `claude` on PATH pointing back here would be found when we spawn `claude`,
// and we'd fork-bomb. We mark the child's environment; seeing that mark on
// startup means we're about to wrap ourselves.
const ACTIVE_ENV: string = 'CLAUDE_AUTO_ACTIVE';

if (process.env[ACTIVE_ENV] === '1') {
    // Safe to write here: the pty doesn't exist yet, so there's no TUI to corrupt.
    process.stderr.write(
        'claude-auto: refusing to wrap itself — "claude" on your PATH points back at claude-auto.\n' +
        '  Use "alias claude=claude-auto" instead of installing it under the name "claude".\n'
    );
    process.exit(1);
}

// ==========================================
// SPAWN CLAUDE
// ==========================================
const cols: number = process.stdout.columns || 80;
const rows: number = process.stdout.rows || 24;

// `claude` is a shell shim on Windows, so it can only be launched through cmd.exe.
const shell = os.platform() === 'win32' ? 'cmd.exe' : 'claude';
const args = os.platform() === 'win32'
    ? ['/c', 'claude', ...forwardedArgs]
    : forwardedArgs;

const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, [ACTIVE_ENV]: '1' } as Record<string, string>,
    useConpty: true,
    // Use the standalone conpty.dll bundled with node-pty for better redraw
    // fidelity than the older in-box Windows ConPTY.
    useConptyDll: true
});

// @xterm/headless ships a CJS bundle whose named exports Node's ESM loader can't
// statically detect, so we pull Terminal in via require() (this project runs
// under tsx). The cast restores the proper types from the package typings.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

// A headless terminal mirrors Claude's TUI so we can read the *rendered* screen
// (the grid of characters the user actually sees) instead of the raw escape
// sequence stream. node-pty feeds it; we never display it.
// allowProposedApi is required to read `term.buffer` in this xterm version.
const term = new Terminal({ cols, rows, allowProposedApi: true });

// ==========================================
// DETECTION STATE
// ==========================================
let isWaiting: boolean = false;     // a confirmed limit countdown is running
let isVerifying: boolean = false;   // inside the post-probe verify window
let isHandlingMenu: boolean = false; // selecting the wait-for-reset menu
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

// Forward everything the user types straight to Claude. The one exception: while
// a countdown is running, F4 cancels it (and is swallowed so it never reaches
// Claude). When no countdown is active, F4 passes through untouched.
process.stdin.on('data', (data: string) => {
    if (isWaiting && F4_SEQUENCES.some(seq => data.includes(seq))) {
        cancelCountdown();
        let rest = data;
        for (const seq of F4_SEQUENCES) rest = rest.split(seq).join('');
        if (rest.length > 0) ptyProcess.write(rest);
        return;
    }
    ptyProcess.write(data);
});

// Forward Claude's output to the real terminal and mirror it into the headless
// terminal so its screen buffer stays in sync with what's on screen.
ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    term.write(data);
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

// Only session-limit text *after* the most recent probe counts; anything above
// the probe is stale. Returns the slice after the last probe occurrence, or all
// of `text` when the probe isn't on screen.
function afterProbe(text: string): string {
    const idx = text.lastIndexOf(VERIFY_PROBE);
    return idx === -1 ? text : text.slice(idx + VERIFY_PROBE.length);
}

// True while Claude's resume-from-summary question is on screen. Answering it is
// the user's call, so we send nothing — not the probe, not the resume.
function hasResumePrompt(screen: string): boolean {
    return screen.toLowerCase().includes(RESUME_PROMPT_TEXT);
}

function detectLimit(screen: string): void {
    // Already handling a limit (waiting it out or mid-verification) — do nothing.
    if (isWaiting || isVerifying || isHandlingMenu) return;

    // Scrolled-up history is stale; ignore it.
    if (screen.includes(SCROLL_INDICATOR)) return;

    // Checked before the menu below, which would answer this question with its Enter.
    if (hasResumePrompt(screen)) {
        log('Resume-from-summary question on screen — detection paused');
        return;
    }

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

    // Ignore any limit text above the most recent probe; only what's below counts.
    const match = afterProbe(screen).match(limitRegex);
    if (!match) return;

    // Skip a reset we've already counted down to (a stale banner re-appearing
    // after we resumed), unless the repeat window has passed — by then the same
    // clock time is a new day's limit.
    if (lastResetMinutes !== null &&
        resetMinutes(match) === lastResetMinutes &&
        Date.now() - lastFoundAt < REPEAT_LIMIT_WINDOW_MS) {
        log('Same reset as last countdown — ignoring');
        return;
    }

    // Candidate limit on the live screen. Confirm it by sending the probe, then
    // after VERIFY_DELAY_MS re-checking the screen below the probe for a limit.
    log('Possible session limit — sending verify probe');
    isVerifying = true;
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + VERIFY_PROBE + '\r');

    setTimeout(() => {
        isVerifying = false;
        const confirm = afterProbe(captureScreen()).match(limitRegex);
        if (confirm) {
            log('Limit re-appeared after probe — confirmed real');
            startCountdown(confirm);
        } else {
            log('No limit after probe — treating as ghost, ignoring');
        }
    }, VERIFY_DELAY_MS);
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
            // Quota is back, but the resume-from-summary question is up: our Enter
            // would answer it. Hold the countdown open and try again next tick, so
            // the session resumes the moment the user has answered.
            if (hasResumePrompt(captureScreen())) {
                log('Timer elapsed but resume-from-summary question is up — holding');
                process.stdout.write('\x1b]0;⏳ Claude Resumes: waiting for your answer\x07');
                return;
            }
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

// Cancel an in-progress countdown (triggered by F4). Clears the remembered reset
// and the time we found it, so the very same limit can be detected again.
function cancelCountdown(): void {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        // Restore the window title saved when the countdown started.
        process.stdout.write('\x1b[23;0t');
    }
    isWaiting = false;
    lastResetMinutes = null;
    lastFoundAt = 0;
    log('Countdown cancelled (F4) — reset cleared, detection re-armed');
}

