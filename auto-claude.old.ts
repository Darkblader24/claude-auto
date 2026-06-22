import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ==========================================
// CONFIGURATION CONSTANTS
// ==========================================
const WAIT_BUFFER_MS: number = 60 * 1000;
const RESUME_GRACE_PERIOD_MS: number = 5000;
const MENU_ENTER_DELAY_MS: number = 2000;

// Tail of the buffer treated as the "live screen". Limit detection only looks at
// this slice so a stale banner sitting in scrollback history can't trigger a
// timer — a real limit is always rendered at the bottom of the current screen.
const LIVE_SCREEN_CHARS: number = 3000;

// Ctrl-U is bound to "clear input / delete the line" in Claude Code. The draft
// can span multiple lines, so we fire it a handful of times to wipe the whole
// composer before we type our own command (fix #6, replaces the old \x08 nuke).
const CLEAR_INPUT_SEQUENCE: string = '\x15'.repeat(8);

// Time to let Claude process the 'continue' command and redraw the UI before checking
const TEST_DELAY_MS: number = 4000;

// Triggers (limit banner, menu) are only evaluated once the TUI output has been
// quiet for this long. A real limit/menu is followed by Claude going idle, whereas
// scrolling re-renders the screen continuously — so this never settles mid-scroll.
// This is the real scroll guard: the footer "↓" arrow is drawn absolutely and is
// never re-emitted into the stream we capture, so it can't be matched on directly.
const IDLE_SETTLE_MS: number = 1000;

// Opt-in logging to a file (fix #13). Set CLAUDE_AUTO_DEBUG=1 to enable.
// We never log to stdout/stderr — that would corrupt Claude's TUI.
const DEBUG: boolean = process.env.CLAUDE_AUTO_DEBUG === '1';
const LOG_FILE: string = path.join(process.cwd(), 'claude-auto.log');

function log(msg: string): void {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
        /* logging must never crash the wrapper */
    }
}

// F2 is a debug-only hotkey: snapshot the current live screen into the log.
// Under ConPTY / most terminals F2 arrives as the SS3 sequence \x1bOQ; in
// "normal" keypad mode it's \x1b[12~. We match both and consume the key so it
// is never forwarded to Claude.
const F2_SEQUENCES: string[] = ['\x1bOQ', '\x1b[12~'];

const MENU_PROMPT_TEXTS: string[] = [
    "stop and wait for limit to reset"
];

// ==========================================
// REGEX & PROCESS SETUP
// ==========================================

// CSI / Fe escape sequences (colours, cursor moves, etc.). \x1b = ESC, \x9b = 8-bit CSI.
const ansiRegex: RegExp = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
// OSC sequences such as window-title sets: ESC ] ... terminated by BEL or ST
// (ESC \). Stripped separately because the CSI regex doesn't understand them (fix #7).
const oscRegex: RegExp = /\x1b][\s\S]*?(?:\x07|\x1b\\)/g;

// Anchored on "hit your session limit" so the percentage early-warning
// ("You've used 90% of your session limit · resets ...") never trips it.
// Time format is lenient (fix #2): optional minutes ("3pm" / "3:30pm"),
// optional space and any case before am/pm ("3:30 PM"), trailing timezone ignored.
const limitRegex: RegExp = /hit your session limit[\s\S]{0,80}?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

const shell = os.platform() === 'win32' ? 'cmd.exe' : 'claude';
const args = os.platform() === 'win32' ? ['/c', 'claude'] : [];

const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    useConpty: true,
    // Use the standalone conpty.dll bundled with node-pty (v1.1.0, the version
    // pinned in package.json) instead of the older in-box Windows ConPTY. The
    // in-box version leaves stale glyphs at line starts during heavy redraws
    // (e.g. scrolling /resume); the bundled build has the rendering fixes.
    useConptyDll: true
});

process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns, process.stdout.rows);
});

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
process.stdin.resume();

process.stdin.on('data', (data: string) => {
    // Intercept F2 (debug only) to dump the exact current screen to the log.
    // We strip the F2 sequence out of the chunk and forward whatever else the
    // user typed, so it behaves purely as a wrapper hotkey.
    let rest: string = data;
    if (DEBUG) {
        let f2Pressed: boolean = false;
        for (const seq of F2_SEQUENCES) {
            if (rest.includes(seq)) {
                f2Pressed = true;
                rest = rest.split(seq).join('');
            }
        }
        if (f2Pressed) {
            log(
                "===== F2: current screen =====\n" +
                outputBuffer.slice(-LIVE_SCREEN_CHARS) +
                "\n===== end current screen ====="
            );
        }
    }

    if (rest.length > 0) {
        ptyProcess.write(rest);
    }
});

// ==========================================
// CLEANUP / TEARDOWN (fix #8)
// ==========================================
let cleanedUp = false;
function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
    }
    // Pop the saved window title off the terminal's title stack in case we exit
    // mid-countdown, then drop the terminal back out of raw mode.
    try { process.stdout.write("\x1b[23;0t"); } catch { /* terminal already gone */ }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
}

process.on('exit', cleanup);
// In raw mode Ctrl-C is forwarded to Claude as \x03, so these handlers only
// fire for out-of-band signals — they won't swallow the user's Ctrl-C.
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ==========================================
// STATE & DETECTION LOGIC
// ==========================================

let outputBuffer: string = "";
let isWaiting: boolean = false;
let isTestingLimit: boolean = false;
let isHandlingMenu: boolean = false;
// True between sending the resume 'continue' and the just-expired limit banner
// clearing off screen — stops that stale banner from triggering a 2nd 'continue'.
let resumeSuppressed: boolean = false;
let countdownInterval: NodeJS.Timeout | null = null;
let settleTimer: NodeJS.Timeout | null = null;
let lastResumeTime: number = 0;

function startCountdown(match: RegExpMatchArray): void {
    isWaiting = true;
    outputBuffer = "";

    // Save the current window title onto the terminal's title stack.
    process.stdout.write("\x1b[22;0t");

    let hours: number = parseInt(match[1]!, 10);
    const minutes: number = match[2] ? parseInt(match[2], 10) : 0;
    const ampm: string = match[3]!.toLowerCase();

    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

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
            isTestingLimit = false;
            lastResumeTime = Date.now();
            outputBuffer = "";
            // Suppress re-detection of the stale banner until it leaves the screen.
            resumeSuppressed = true;

            // Restore the original window title and resume the session.
            process.stdout.write("\x1b[23;0t");
            log("Timer elapsed — sending 'continue' to resume");
            ptyProcess.write(CLEAR_INPUT_SEQUENCE + "continue\r");
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

// Runs only once the TUI output has settled (see IDLE_SETTLE_MS). Because active
// scrolling re-renders continuously, the output never settles mid-scroll, so none
// of this fires on scrolled-back history — which is the real scroll guard.
function evaluateTriggers(): void {
    settleTimer = null;

    const currentScreen = outputBuffer.slice(-LIVE_SCREEN_CHARS);

    if (DEBUG && limitRegex.test(currentScreen)) {
        log("===== SETTLED: limit text in live screen =====");
        log("window=" + JSON.stringify(currentScreen));
    }

    // --- MENU PROMPT DETECTION ---
    // Only on the live screen + settled, so the menu's text appearing in scrolled
    // history (or chat content) can't make us press Enter.
    if (!isHandlingMenu && !isWaiting && !isTestingLimit) {
        const lowerScreen = currentScreen.toLowerCase();
        for (const promptText of MENU_PROMPT_TEXTS) {
            if (lowerScreen.includes(promptText)) {
                isHandlingMenu = true;
                outputBuffer = outputBuffer.replace(new RegExp(promptText, 'ig'), '');
                log(`Menu detected ("${promptText}") — pressing Enter once`);
                setTimeout(() => {
                    ptyProcess.write("\r");
                    // Release after a grace period so a genuinely new menu can
                    // still be handled later.
                    setTimeout(() => { isHandlingMenu = false; }, RESUME_GRACE_PERIOD_MS);
                }, MENU_ENTER_DELAY_MS);
                return;
            }
        }
    }

    // --- LIMIT DETECTION & COUNTDOWN ---
    if (!isWaiting && !isTestingLimit && !isHandlingMenu && !resumeSuppressed && (Date.now() - lastResumeTime > RESUME_GRACE_PERIOD_MS)) {

        if (limitRegex.test(currentScreen)) {
            // PHASE 1: A limit is on the settled live screen. Lock state and test it.
            isTestingLimit = true;
            log("Possible session limit detected — typing 'continue' to verify");

            // Wipe the buffer so anything matched in phase 2 is necessarily what
            // Claude printed *after* our 'continue' submission.
            outputBuffer = "";
            ptyProcess.write(CLEAR_INPUT_SEQUENCE + "continue\r");

            setTimeout(() => {
                // PHASE 2: the buffer was cleared before we submitted, so a fresh
                // match on the live screen means the limit re-appeared in response
                // = real limit. (Replaces the old split("continue") heuristic, which
                // broke when "continue" showed up in Claude's own output — fix #4.)
                const confirm = outputBuffer.slice(-LIVE_SCREEN_CHARS).match(limitRegex);

                if (confirm) {
                    log("Limit re-appeared after 'continue' — confirmed real");
                    startCountdown(confirm);
                } else {
                    // No limit after 'continue'. The earlier match was a stale
                    // redraw / scrollback ghost.
                    log("No limit after 'continue' — treating as ghost, ignoring");
                    isTestingLimit = false;
                    lastResumeTime = Date.now();
                }
            }, TEST_DELAY_MS);
        }
    }
}

ptyProcess.onData((data: string) => {
    // Forward Claude's UI stream
    process.stdout.write(data);


    const cleanText: string = data.replace(oscRegex, '').replace(ansiRegex, '');
    outputBuffer += cleanText;

    log(data);
    log(cleanText);
    log(" ")

    if (outputBuffer.length > 10000) {
        outputBuffer = outputBuffer.slice(-10000);
    }

    // After a resume, keep ignoring the just-expired limit banner until it has
    // scrolled off the live screen, then drop the stale copy and re-arm. This is
    // what stops a second 'continue' from being fired at the same old banner.
    // Kept on every chunk (not debounced) so it re-arms promptly.
    if (resumeSuppressed && !limitRegex.test(outputBuffer.slice(-LIVE_SCREEN_CHARS))) {
        resumeSuppressed = false;
        outputBuffer = "";
        lastResumeTime = Date.now();
        log("Post-resume banner cleared — detection re-armed");
    }

    // Defer all trigger evaluation until the output goes quiet (debounce). While
    // the user scrolls, the TUI re-renders nonstop, so this timer keeps resetting
    // and evaluateTriggers() never runs.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(evaluateTriggers, IDLE_SETTLE_MS);
});

ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    cleanup();
    process.exit(exitCode);
});
