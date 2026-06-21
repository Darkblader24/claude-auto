import * as pty from 'node-pty';
import * as os from 'os';

// ==========================================
// CONFIGURATION CONSTANTS
// ==========================================
const WAIT_BUFFER_MS: number = 60 * 1000;
const RESUME_GRACE_PERIOD_MS: number = 5000;
const MENU_ENTER_DELAY_MS: number = 2000;
const BACKSPACE_COUNT: number = 50;

// Time to let Claude process the 'continue' command and redraw the UI before checking
const TEST_DELAY_MS: number = 4000;

const MENU_PROMPT_TEXTS: string[] = [
    "stop and wait for limit to reset"
];

// The specific string Claude's TUI uses when scrolled up
const SCROLL_INDICATOR: string = ") ↓";

// ==========================================
// REGEX & PROCESS SETUP
// ==========================================

const ansiRegex: RegExp = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const limitRegex: RegExp = /hit your session limit[\s\S]{0,50}resets\s+(\d{1,2}):(\d{2})(am|pm)/i;

const shell = os.platform() === 'win32' ? 'cmd.exe' : 'claude';
const args = os.platform() === 'win32' ? ['/c', 'claude'] : [];

const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    useConpty: true,
    // Use the standalone conpty.dll bundled with node-pty (v1.23, Oct 2025)
    // instead of the older in-box Windows ConPTY (build 26100). The in-box
    // version leaves stale glyphs at line starts during heavy redraws (e.g.
    // scrolling /resume); the bundled build has the rendering fixes.
    useConptyDll: true
});

process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns, process.stdout.rows);
});

process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on('data', (data: string) => {
    ptyProcess.write(data);
});

// ==========================================
// STATE & DETECTION LOGIC
// ==========================================

let outputBuffer: string = "";
let isWaiting: boolean = false;
let isTestingLimit: boolean = false;
let countdownInterval: NodeJS.Timeout | null = null;
let lastResumeTime: number = 0;

ptyProcess.onData((data: string) => {
    // Forward Claude's UI stream
    process.stdout.write(data);

    const cleanText: string = data.replace(ansiRegex, '');
    outputBuffer += cleanText;

    if (outputBuffer.length > 10000) {
        outputBuffer = outputBuffer.slice(-10000);
    }

    // Check if the user is currently scrolled up
    const currentScreen = outputBuffer.slice(-3000);
    const isScrolledUp = currentScreen.includes(SCROLL_INDICATOR);

    // --- MENU PROMPT DETECTION ---
    const lowerBuffer = outputBuffer.toLowerCase();
    for (const promptText of MENU_PROMPT_TEXTS) {
        if (lowerBuffer.includes(promptText)) {
            outputBuffer = outputBuffer.replace(new RegExp(promptText, 'ig'), '');
            setTimeout(() => {
                ptyProcess.write("\r");
            }, MENU_ENTER_DELAY_MS);
            break;
        }
    }

    // --- DETECTION & COUNTDOWN LOGIC ---
    if (!isWaiting && !isTestingLimit && !isScrolledUp && (Date.now() - lastResumeTime > RESUME_GRACE_PERIOD_MS)) {

        const match = outputBuffer.match(limitRegex);

        if (match) {
            // PHASE 1: A limit was found. Lock the state and test it.
            isTestingLimit = true;

            // Wipe the buffer completely so we only record what happens AFTER we type continue
            outputBuffer = "";
            ptyProcess.write('\x08'.repeat(BACKSPACE_COUNT) + "continue\r");

            // Wait for Claude to process and redraw the UI
            setTimeout(() => {

                // PHASE 2: Evaluate spatial order
                const parts = outputBuffer.toLowerCase().split("continue");
                const textAfterContinue = parts[parts.length - 1];

                const realLimitMatch = textAfterContinue.match(limitRegex);

                if (realLimitMatch) {
                    // It appeared AFTER our continue command. It is a real limit block!
                    isWaiting = true;
                    outputBuffer = "";

                    process.stdout.write("\x1b[22;0t");

                    let hours: number = parseInt(realLimitMatch[1], 10);
                    const minutes: number = parseInt(realLimitMatch[2], 10);
                    const ampm: string = realLimitMatch[3].toLowerCase();

                    if (ampm === 'pm' && hours < 12) hours += 12;
                    if (ampm === 'am' && hours === 12) hours = 0;

                    const now = new Date();
                    let targetTimeMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0).getTime();

                    targetTimeMs += WAIT_BUFFER_MS;

                    if (targetTimeMs < Date.now()) {
                        targetTimeMs += 24 * 60 * 60 * 1000;
                    }

                    countdownInterval = setInterval(() => {
                        const remainingMs = targetTimeMs - Date.now();

                        if (remainingMs <= 0) {
                            clearInterval(countdownInterval!);
                            isWaiting = false;
                            isTestingLimit = false;
                            lastResumeTime = Date.now();
                            outputBuffer = "";

                            process.stdout.write("\x1b[23;0t");
                            ptyProcess.write('\x08'.repeat(BACKSPACE_COUNT) + "continue\r");
                        } else {
                            const totalSeconds = Math.floor(remainingMs / 1000);
                            const h = Math.floor(totalSeconds / 3600);
                            const m = Math.floor((totalSeconds % 3600) / 60);
                            const s = totalSeconds % 60;

                            const timeStr = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
                            process.stdout.write(`\x1b]0;⏳ Claude Resumes: ${timeStr}\x07`);
                        }
                    }, 1000);
                } else {
                    // No limit message after "continue". The old message was just a ghost.
                    isTestingLimit = false;
                    lastResumeTime = Date.now();
                }
            }, TEST_DELAY_MS);
        }
    }
});

ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (countdownInterval) clearInterval(countdownInterval);
    process.exit(exitCode);
});