#!/usr/bin/env node
import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'node:module';

// ==========================================
// CLI ARGS
// ==========================================
// This wrapper is a drop-in replacement for `claude`: every argument we don't
// recognise is forwarded verbatim to the real CLI. Our own flags are namespaced
// with an `auto-` prefix so they can't collide with claude's (`claude --debug`
// is a real flag), and they are stripped before forwarding.
const AUTO_MODE_OFF_FLAG: string = '--no-auto-mode';
const WRAPPER_FLAGS: ReadonlySet<string> = new Set(['--auto-debug', AUTO_MODE_OFF_FLAG]);

// Debug logging is opt-in via a flag (no env var). Pass --auto-debug.
const DEBUG: boolean = process.argv.includes('--auto-debug');

// Everything after `node claude-auto.ts`, minus our own flags.
const cliArgs: string[] = process.argv.slice(2).filter(arg => !WRAPPER_FLAGS.has(arg));

// Sessions start in auto mode: we forward `--permission-mode auto` by default, so
// claude-auto doesn't stop to ask on every tool call — the point of the wrapper is
// to keep going while you're away. Three things opt out of it:
//   * --no-auto-mode, ours, for when you just want claude's own default;
//   * an explicit --permission-mode, which is you naming a mode, so it wins;
//   * --dangerously-skip-permissions, which claude rejects alongside a mode.
const AUTO_MODE: string = 'auto';
const PERMISSION_MODE_FLAG: string = '--permission-mode';
const SKIP_PERMISSIONS_FLAG: string = '--dangerously-skip-permissions';

function permissionModeArgs(args: string[]): string[] {
    if (process.argv.includes(AUTO_MODE_OFF_FLAG)) return [];
    const alreadySet: boolean = args.some(arg =>
        arg === PERMISSION_MODE_FLAG ||
        arg.startsWith(`${PERMISSION_MODE_FLAG}=`) ||
        arg === SKIP_PERMISSIONS_FLAG
    );
    return alreadySet ? [] : [PERMISSION_MODE_FLAG, AUTO_MODE];
}

const forwardedArgs: string[] = [...cliArgs, ...permissionModeArgs(cliArgs)];

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
const MENU_PROMPT_TEXT: string = '❯ stop and wait for limit to reset';
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
const RESUME_PROMPT_TEXT: string = '❯ resume from summary';

// A candidate limit is verified through the /usage panel instead of a chat
// probe: we open it, read the "Current session" block (percent used + reset
// time), and close it again. The reset time shown there is authoritative —
// banner times are rounded and the banner itself can be stale.
const USAGE_COMMAND: string = '/usage';
// Pause between typing the command and pressing Enter, so the slash-command
// autocomplete has settled on /usage before we submit it.
const USAGE_MENU_SETTLE_MS: number = 500;
// Pause after Enter before the first read, so the panel has rendered.
const USAGE_RENDER_DELAY_MS: number = 1500;

// Headings that bracket the block we read. The weekly rows below it also say
// "% used", so anything past USAGE_NEXT_HEADING must never be matched.
const USAGE_SESSION_HEADING: string = 'current session';
const USAGE_NEXT_HEADING: string = 'current week';
// "███ 54% used" and "Resets 11:50am (Europe/Berlin)". The weekly rows show a
// date instead ("Resets Jul 15, 8am"), which the time-only regex skips.
const usagePercentRegex: RegExp = /(\d{1,3})\s*%\s*used/i;
const usageResetRegex: RegExp = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// The panel confirms a limit only when the session bar reads 100% used.
// Anything less means the banner that triggered us was stale.
const USAGE_CONFIRM_PCT: number = 100;

// When the window is too small to show the whole block at once, we scroll the
// panel one step at a time (down arrow) and re-read, up to this many steps.
const USAGE_SCROLL_KEY: string = '\x1b[B';
const USAGE_SCROLL_DELAY_MS: number = 300;
const USAGE_MAX_SCROLL_STEPS: number = 40;

// Esc closes the panel; give the main screen a moment to redraw afterwards.
const USAGE_CLOSE_KEY: string = '\x1b';
const USAGE_CLOSE_DELAY_MS: number = 500;

// A banner /usage disproved (session below 100%) is remembered by its reset time
// and never verified again — re-opening the panel for it would find the same
// answer. It's re-armed when a real limit is hit, or after this long, by which
// point the same clock time belongs to a later session.
const DISPROVED_LIMIT_WINDOW_MS: number = 3 * 60 * 60 * 1000;

// When /usage couldn't be read at all we've learned nothing about the banner, so
// this is a plain retry backoff — long enough that the popup isn't disruptive.
const USAGE_RETRY_COOLDOWN_MS: number = 5 * 60 * 1000;

// Safety margin added on top of the /usage reset time before we resume.
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
// UPDATE NOTICE
// ==========================================
// A global npm install never updates itself, so a user can sit on an old build
// indefinitely. That matters more here than for most tools: limit detection
// keys off Claude Code's rendered wording, so when that wording changes, an
// outdated copy stops resuming *silently* — it looks like claude-auto is broken
// rather than stale. So we tell them a newer version exists.
//
// Two constraints shape this, and neither is negotiable:
//   1. Claude owns the terminal while it runs. Writing anything to stdout mid-
//      session corrupts its render, so the notice is printed only from cleanup(),
//      once the pty is gone and the screen is ours again. It goes to stderr so
//      that `claude-auto -p '...' > out.txt` keeps a clean stdout.
//   2. A session must never wait on the network. So we never fetch-then-print:
//      we print from a cache a *previous* run wrote, and refresh that cache in
//      the background. First run shows nothing; every run after is instant.
const PACKAGE_NAME: string = '@hotox/claude-auto';
const REGISTRY_URL: string = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const UPDATE_CACHE_FILE: string = path.join(os.homedir(), '.claude-auto', 'update-check.json');

// How stale the cache may get before we refresh it. The notice is a nudge, not
// news — checking once a day is plenty and keeps us off the registry.
const UPDATE_CHECK_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

// The refresh is fire-and-forget, but an abandoned socket would still hold the
// event loop open at exit, so it gets a hard deadline.
const UPDATE_FETCH_TIMEOUT_MS: number = 3000;

// Opt-out for anyone who doesn't want the check (or is offline/air-gapped).
const UPDATE_OPT_OUT_ENV: string = 'CLAUDE_AUTO_NO_UPDATE_CHECK';

interface UpdateCache {
    checkedAt: number;
    latest: string;
}

const requireFrom = createRequire(import.meta.url);

// package.json sits next to the source in dev but one level up from dist/ once
// installed. Rather than guess the layout, try both and take whichever is
// actually ours — checking the name means a stray package.json can't fool us.
function readOwnVersion(): string {
    for (const rel of ['./package.json', '../package.json']) {
        try {
            const pkg = requireFrom(rel) as { name?: string; version?: string };
            if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
        } catch {
            /* not there — try the next candidate */
        }
    }
    return '0.0.0'; // unknown version: compares older than everything, so we stay quiet
}

const VERSION: string = readOwnVersion();

// True when `latest` is strictly ahead of `current`. Compares major/minor/patch
// numerically and ignores any prerelease suffix: we only ever read the `latest`
// dist-tag, so a prerelease can't show up here unless someone tags one as latest.
function isNewer(latest: string, current: string): boolean {
    const parts = (v: string): number[] =>
        v.split('-')[0]!.split('.').map(n => parseInt(n, 10) || 0);
    const [a, b] = [parts(latest), parts(current)];
    for (let i = 0; i < 3; i++) {
        const [x, y] = [a[i] ?? 0, b[i] ?? 0];
        if (x !== y) return x > y;
    }
    return false;
}

function readUpdateCache(): UpdateCache | null {
    try {
        return JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8')) as UpdateCache;
    } catch {
        return null; // absent or corrupt — treated the same: nothing to say yet
    }
}

// Refresh the cache for the *next* run. Deliberately not awaited: nothing in
// this process depends on the result, and unref'ing the timeout means a slow
// registry can never hold the exit open.
function refreshUpdateCache(): void {
    const cache = readUpdateCache();
    if (cache && Date.now() - cache.checkedAt < UPDATE_CHECK_INTERVAL_MS) return;

    void (async (): Promise<void> => {
        try {
            const res = await fetch(REGISTRY_URL, {
                signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
                headers: { accept: 'application/vnd.npm.install-v1+json' }
            });
            if (!res.ok) return;
            const { version } = await res.json() as { version?: string };
            if (!version) return;

            const next: UpdateCache = { checkedAt: Date.now(), latest: version };
            fs.mkdirSync(path.dirname(UPDATE_CACHE_FILE), { recursive: true });
            fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(next));
            log(`update check: latest=${version} current=${VERSION}`);
        } catch {
            /* offline, rate-limited, registry down — a nudge isn't worth a warning */
        }
    })();
}

// Called from cleanup(), i.e. only once the pty is dead. Reads the cache the
// previous run left behind; never touches the network.
function printUpdateNotice(): void {
    if (process.env[UPDATE_OPT_OUT_ENV] === '1') return;
    // Not a terminal? Then stderr is a log or a pipe, and this is just noise.
    if (!process.stderr.isTTY) return;

    const cache = readUpdateCache();
    if (!cache?.latest || !isNewer(cache.latest, VERSION)) return;

    process.stderr.write(
        `\nclaude-auto ${VERSION} → ${cache.latest} — update with:\n` +
        `  npm install -g ${PACKAGE_NAME}@latest\n`
    );
}

// ==========================================
// ALIAS INSTALL
// ==========================================
// `alias claude=claude-auto` typed at a prompt lives and dies with that shell —
// on every platform, Linux included. No shell persists an alias for you (fish's
// `alias --save` is the one exception), so to make it stick the line has to sit
// in a startup file the shell re-reads on every launch. --install-alias puts it
// there, --uninstall-alias takes it back out.
//
// The line is fenced between markers, which is what makes both idempotent: we
// only ever rewrite what's between our own markers, so re-installing doesn't
// stack up duplicates and uninstalling can't take a line the user wrote with it.
const ALIAS_INSTALL_FLAG: string = '--install-alias';
const ALIAS_UNINSTALL_FLAG: string = '--uninstall-alias';
const ALIAS_BEGIN: string = '# >>> claude-auto alias >>>';
const ALIAS_END: string = '# <<< claude-auto alias <<<';

// Colour the final verdict so it can't be missed in a wall of per-file output.
// NO_COLOR / a non-TTY stdout means the codes would just be noise, so drop them.
function colorize(code: string, msg: string): string {
    const on: boolean = process.stdout.isTTY === true && !process.env.NO_COLOR;
    return on ? `\x1b[${code}m${msg}\x1b[0m` : msg;
}
const green = (msg: string): string => colorize('32', msg);
const red = (msg: string): string => colorize('31', msg);

interface AliasTarget {
    shell: string;  // what to call it when we report back
    file: string;   // the startup file to edit
    line: string;   // the alias, in that shell's syntax
    reload: string; // how to pick it up without opening a new shell
}

// Which file a POSIX shell actually re-reads on launch. Nothing here is a guess
// we can make from the OS alone — it's the shell that decides, so we read $SHELL.
function posixTarget(): AliasTarget | null {
    const name: string = path.basename(process.env.SHELL ?? '');
    const home: string = os.homedir();

    if (name.includes('fish')) {
        const file: string = path.join(home, '.config', 'fish', 'config.fish');
        return { shell: 'fish', file, line: 'alias claude claude-auto', reload: `source ${file}` };
    }
    if (name.includes('zsh')) {
        // ZDOTDIR moves the whole zsh config elsewhere; when it's set, .zshrc there is the one being read.
        const file: string = path.join(process.env.ZDOTDIR || home, '.zshrc');
        return { shell: 'zsh', file, line: "alias claude='claude-auto'", reload: `source ${file}` };
    }
    if (name.includes('bash')) {
        // On macOS, Terminal.app opens *login* shells, which read .bash_profile and
        // never .bashrc. Everywhere else .bashrc is the interactive-shell file.
        const file: string = path.join(home, os.platform() === 'darwin' ? '.bash_profile' : '.bashrc');
        return { shell: 'bash', file, line: "alias claude='claude-auto'", reload: `source ${file}` };
    }
    return null;
}

// PowerShell knows where its own profile lives ($PROFILE), and the path isn't
// reliably derivable from outside — Documents can be redirected to OneDrive, and
// pwsh and Windows PowerShell use different folders. So we ask each one that's
// installed, and install into every profile we get back: the user may well use both.
function powershellTargets(): AliasTarget[] {
    const targets: AliasTarget[] = [];
    for (const exe of ['pwsh', 'powershell']) {
        try {
            const file: string = execFileSync(exe, ['-NoProfile', '-Command', '$PROFILE'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            // Same profile from both exes would mean editing one file twice.
            if (file && !targets.some(t => t.file === file)) {
                targets.push({
                    shell: exe,
                    file,
                    line: 'Set-Alias claude claude-auto',
                    reload: `. $PROFILE`
                });
            }
        } catch {
            /* not installed, or refused to run — try the other one */
        }
    }
    return targets;
}

function aliasTargets(): AliasTarget[] {
    // The shell we were launched from decides this, not the platform: Git Bash and
    // MSYS run on Windows, set $SHELL, and read the usual POSIX startup files. So a
    // POSIX shell wins wherever we find one, and PowerShell is what "Windows, and no
    // $SHELL" means. (cmd.exe also lands here — it has no startup file at all, which
    // is why the empty-targets message below sends those users to PowerShell.)
    const posix: AliasTarget | null = posixTarget();
    if (posix) return [posix];
    return os.platform() === 'win32' ? powershellTargets() : [];
}

// A startup file we didn't create is the user's file, so we leave its line
// endings the way we found them — a PowerShell $PROFILE is normally CRLF, and
// silently rewriting the whole thing to LF is not ours to do.
function eolOf(text: string): string {
    if (text === '') return os.EOL;
    return text.includes('\r\n') ? '\r\n' : '\n';
}

// Drop our fenced block, if it's there. Everything outside the markers is the
// user's and comes back out untouched.
function stripAliasBlock(text: string): string {
    const eol: string = eolOf(text);
    const kept: string[] = [];
    let inBlock: boolean = false;
    for (const line of text.split(/\r?\n/)) {
        if (!inBlock && line.trim() === ALIAS_BEGIN) { inBlock = true; continue; }
        if (inBlock) {
            if (line.trim() === ALIAS_END) inBlock = false;
            continue;
        }
        kept.push(line);
    }
    // An unterminated block (someone deleted the end marker) would swallow the rest
    // of the file, so in that case we keep the original and let the caller notice.
    return inBlock ? text : kept.join(eol);
}

function readIfExists(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return ''; // no startup file yet — a fresh PowerShell install has none
    }
}

function writeAliasFile(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

// Both commands report to stdout: here the output *is* the point, and the pty
// doesn't exist yet, so there's no TUI to corrupt. Returns the process exit code.
function runAliasCommand(install: boolean): number {
    const targets: AliasTarget[] = aliasTargets();
    const out = (msg: string): void => { process.stdout.write(msg + '\n'); };

    if (targets.length === 0) {
        out(
            "claude-auto: couldn't work out which shell to write to.\n" +
            '  Add the alias to your shell\'s startup file by hand:\n' +
            "    bash/zsh   alias claude='claude-auto'      (~/.bashrc, ~/.zshrc)\n" +
            '    fish       alias --save claude claude-auto\n' +
            '    PowerShell Set-Alias claude claude-auto    ($PROFILE)\n' +
            '  cmd.exe has no startup file: a permanent doskey macro needs the\n' +
            '  Command Processor AutoRun registry key. Use PowerShell instead.'
        );
        out(red(`claude-auto: alias ${install ? 'install' : 'uninstall'} failed.`));
        return 1;
    }

    let changed: number = 0;
    for (const target of targets) {
        const before: string = readIfExists(target.file);
        const hasBlock: boolean = before.includes(ALIAS_BEGIN);

        // Nothing of ours in the file: there is nothing to take out, and rewriting
        // it just to reformat what's already there would be pure vandalism.
        if (!install && !hasBlock) {
            out(`claude-auto: nothing to do — no claude-auto alias in ${target.file}.`);
            continue;
        }

        const stripped: string = stripAliasBlock(before);
        if (hasBlock && stripped === before) {
            out(`claude-auto: ${target.file} has an unterminated claude-auto block — fix it by hand.`);
            continue;
        }

        // Uninstall is just the strip. Install re-appends, so an existing block is
        // replaced rather than duplicated (and picks up any change to the syntax).
        const eol: string = eolOf(before);
        const body: string = stripped.replace(/\s+$/, '');
        const after: string = install
            ? `${body ? body + eol + eol : ''}${ALIAS_BEGIN}${eol}${target.line}${eol}${ALIAS_END}${eol}`
            : (body ? body + eol : '');

        if (after === before) {
            out(`claude-auto: nothing to do — ${target.file} is already set up.`);
            continue;
        }

        try {
            writeAliasFile(target.file, after);
        } catch (err) {
            out(`claude-auto: couldn't write ${target.file} — ${String(err)}`);
            out(red(`claude-auto: alias ${install ? 'install' : 'uninstall'} failed.`));
            return 1;
        }
        changed++;
        out(install
            ? `claude-auto: added "${target.line}" to ${target.file} (${target.shell})`
            : `claude-auto: removed the alias from ${target.file} (${target.shell})`);
        out(`  Open a new shell, or run: ${target.reload}`);
    }

    // A profile that PowerShell refuses to execute is loaded by nobody, so the
    // alias we just wrote would silently never appear.
    if (install && changed > 0 && os.platform() === 'win32') warnIfProfilesBlocked();
    out(green(
        `claude-auto: alias ${install ? 'install' : 'uninstall'} successful — ` +
        'restart your terminal for it to take effect.'
    ));
    return 0;
}

function warnIfProfilesBlocked(): void {
    try {
        const policy: string = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-ExecutionPolicy'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (/^(Restricted|AllSigned)$/i.test(policy)) {
            process.stdout.write(
                `\nHeads up: your PowerShell execution policy is ${policy}, so profile scripts don't run\n` +
                '  and the alias will never load. Allow local scripts with:\n' +
                '    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned\n'
            );
        }
    } catch {
        /* couldn't ask — not worth failing the install over */
    }
}

if (process.argv.includes(ALIAS_INSTALL_FLAG) || process.argv.includes(ALIAS_UNINSTALL_FLAG)) {
    process.exit(runAliasCommand(process.argv.includes(ALIAS_INSTALL_FLAG)));
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
        `  Alias it instead of installing it under the name "claude": claude-auto ${ALIAS_INSTALL_FLAG}\n`
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

// Claude is already starting; this rides along in the background and only
// affects what the *next* run prints.
refreshUpdateCache();

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
let isVerifying: boolean = false;   // /usage panel is open for verification
let isHandlingMenu: boolean = false; // selecting the wait-for-reset menu
let countdownInterval: NodeJS.Timeout | null = null;
let lastResetMinutes: number | null = null; // banner reset (minutes-of-day) of last countdown
let lastFoundAt: number = 0;                 // wall-clock time we started that countdown
let disprovedResetMinutes: number | null = null; // banner reset /usage said wasn't a limit
let disprovedAt: number = 0;                     // wall-clock time /usage disproved it
let usageRetryUntil: number = 0;             // no /usage re-read before this (read failed)
let captureInterval: NodeJS.Timeout | null = null;
let currentScreen: string = '';

// ==========================================
// WINDOW TITLE
// ==========================================
// The countdown takes the window title over, so it has to put back whatever was
// there before. xterm's title stack (ESC[22;0t to push, ESC[23;0t to pop) does
// that in one sequence, but not every terminal implements it — macOS
// Terminal.app ignores both, and the title is left showing a countdown that
// finished. So we keep the title ourselves instead: Claude sets it with an OSC
// sequence, and every byte it writes passes through us on the way to the
// terminal, so we can read the title off that stream and write it back verbatim.
// Only OSC 0 (icon + title) and OSC 2 (title) carry one; both end in BEL or ST.
const oscTitleRegex: RegExp = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// A sequence can be split across two pty chunks, so an unfinished one is carried
// into the next scan. Capped, so an introducer that never gets its terminator
// can't grow the carry without bound.
const TITLE_CARRY_MAX: number = 4096;

let childTitle: string = '';          // the last title Claude set ('' until it sets one)
let titleCarry: string = '';          // partial sequence carried between chunks
let titleOverridden: boolean = false; // the countdown is currently showing its own title

// Scan a chunk of Claude's output for title sequences, keeping the last one.
function trackTitle(data: string): void {
    const stream: string = titleCarry + data;
    let consumed: number = 0;
    let match: RegExpExecArray | null;
    oscTitleRegex.lastIndex = 0;
    while ((match = oscTitleRegex.exec(stream)) !== null) {
        childTitle = match[1]!;
        consumed = oscTitleRegex.lastIndex;
    }
    titleCarry = pendingOsc(stream.slice(consumed));
    if (titleCarry.length > TITLE_CARRY_MAX) titleCarry = '';
}

// The part of a chunk that may be an OSC sequence still waiting for the rest of
// itself: from the last *unterminated* ESC ] onwards, or a lone trailing ESC
// that could become one. Note it can't just be "from the last ESC" — the ESC of
// an ST terminator sits inside the very sequence we're trying to keep.
// An OSC that's already terminated is one we didn't want (OSC 8, OSC 10, …), so
// it's dropped rather than carried, which is what keeps the carry from growing.
function pendingOsc(rest: string): string {
    const start: number = rest.lastIndexOf('\x1b]');
    if (start !== -1) {
        const tail: string = rest.slice(start);
        const terminated: boolean = tail.includes('\x07') || tail.indexOf('\x1b\\', 1) !== -1;
        if (!terminated) return tail;
    }
    return rest.endsWith('\x1b') ? '\x1b' : '';
}

function setTitle(title: string): void {
    try {
        process.stdout.write(`\x1b]0;${title}\x07`);
    } catch { /* terminal already gone */ }
}

// Put back the title Claude last set. If it never set one, that's the empty
// title an untitled window has anyway. No-op unless the countdown took it over.
function restoreTitle(): void {
    if (!titleOverridden) return;
    titleOverridden = false;
    setTitle(childTitle);
}

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
    trackTitle(data);
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

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// CLEANUP / TEARDOWN
// ==========================================
// A TUI switches the terminal into modes a plain shell never uses: mouse
// reporting, bracketed paste, a hidden cursor, a shrunk scroll region, the
// alternate screen. Claude undoes its own when it shuts down cleanly, but a
// killed session (or one whose final bytes we cut off) leaves them set, and the
// shell inherits them — a stray mouse move then prints things like "[<35;1;1M".
// So we put the terminal back ourselves. Every one of these is a no-op if the
// mode was already off, which makes it safe to send unconditionally.
//
// Two of them move the cursor as a side effect, though, and would leave it at
// the top of the window instead of on the line your prompt should return to:
// resetting the scroll region homes the cursor, and leaving the alternate
// screen restores the cursor saved when it was *entered* — stale, since Claude
// has normally left the alt screen already by the time we get here. So the whole
// block is bracketed in DECSC/DECRC (ESC 7 / ESC 8), which puts the cursor back
// where the exiting session left it. DECRC also restores the attributes DECSC
// saved, so the SGR reset has to come after it, not inside.
const TERMINAL_RESET: string =
    '\x1b7' +                                                    // save cursor (position + attrs)
    '\x1b[?1049l' +                                              // leave the alternate screen
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' +  // all mouse reporting off
    '\x1b[?2004l' +                                              // bracketed paste off
    '\x1b[?7h' +                                                 // autowrap back on
    '\x1b[?25h' +                                                // cursor visible again
    '\x1b[r' +                                                   // scroll region = whole window
    '\x1b8' +                                                    // and put the cursor back
    '\x1b[0m';                                                   // drop leftover colours/attrs

// How long we let stdout drain before giving up and exiting anyway.
const FLUSH_TIMEOUT_MS: number = 500;

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
    }
    restoreTitle();
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* terminal already gone */ }
    process.stdin.pause();
    // From here on the pty is gone, so the screen is finally ours to write to.
    try { process.stdout.write(TERMINAL_RESET); } catch { /* terminal already gone */ }
    printUpdateNotice();
}

// process.exit() drops anything still queued on stdout, and on Windows a TTY
// stdout is *asynchronous* — so exiting the instant the pty dies truncates the
// tail of Claude's output mid-escape-sequence and leaves the wreckage on screen.
// Wait for the queue to flush first. The timeout is the backstop for a terminal
// that has stopped draining (closed window, dead ssh link), which must not hang us.
function exitAfterFlush(code: number): void {
    let exited: boolean = false;
    const done = (): void => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        process.exit(code);
    };
    const timer: NodeJS.Timeout = setTimeout(done, FLUSH_TIMEOUT_MS);
    // An empty write's callback fires once everything queued ahead of it is out.
    process.stdout.write('', () => done());
}

process.on('exit', cleanup);
// In raw mode Ctrl-C is forwarded to Claude as \x03, so these handlers only fire
// for out-of-band signals — they won't swallow the user's Ctrl-C.
process.on('SIGINT', () => { cleanup(); exitAfterFlush(0); });
process.on('SIGTERM', () => { cleanup(); exitAfterFlush(0); });

ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    cleanup();
    exitAfterFlush(exitCode);
});

// ==========================================
// MAIN PROCESS
// ==========================================

function main(): void {
    log('===== START =====');
    log(`Forwarding to claude: ${forwardedArgs.join(' ')}`);
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
    logScreen();
    detectLimit(currentScreen);
}

function logScreen(screen: string = currentScreen, msg: string = "SCREEN"): void {
    log(msg +
      '\n##################################################' +
      '\n' + screen +
      '\n##################################################');
}

// ==========================================
// LIMIT DETECTION
// ==========================================
// Parse a reset clock time match into minutes-of-day (0–1439). Both the banner
// regex and the /usage regex capture (hours)(:minutes)(am/pm) in groups 1–3.
function resetMinutes(match: RegExpMatchArray): number {
    let hours: number = parseInt(match[1]!, 10);
    const minutes: number = match[2] ? parseInt(match[2], 10) : 0;
    const ampm: string = match[3]!.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

// True while Claude's resume-from-summary question is on screen. Answering it is
// the user's call, so we send nothing — not /usage, not the resume.
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
    // "/usage" into the menu), so handle it here and bail out.
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

    const bannerMinutes = resetMinutes(match);

    // Skip a reset we've already counted down to (a stale banner re-appearing
    // after we resumed), unless the repeat window has passed — by then the same
    // clock time is a new day's limit.
    if (lastResetMinutes !== null &&
        bannerMinutes === lastResetMinutes &&
        Date.now() - lastFoundAt < REPEAT_LIMIT_WINDOW_MS) {
        log('Same reset as last countdown — ignoring');
        return;
    }

    // This exact banner was already checked against /usage and disproved. Opening
    // the panel again would only find the same answer, so leave it alone until a
    // real limit re-arms detection or the window expires.
    if (disprovedResetMinutes !== null &&
        bannerMinutes === disprovedResetMinutes &&
        Date.now() - disprovedAt < DISPROVED_LIMIT_WINDOW_MS) {
        log('Same reset /usage already disproved — ignoring');
        return;
    }

    // A previous /usage read failed; back off before opening the panel again.
    if (Date.now() < usageRetryUntil) {
        log('Limit text on screen but inside /usage retry backoff — ignoring');
        return;
    }

    // Candidate limit on the live screen. Confirm it against /usage: the banner
    // is only trusted when the Current session bar actually reads 100% used.
    log('Possible session limit — opening /usage to verify');
    isVerifying = true;
    verifyViaUsage(bannerMinutes)
        .catch(err => log(`/usage verification error: ${err}`))
        .finally(() => { isVerifying = false; });
}

// ==========================================
// /usage VERIFICATION
// ==========================================
interface SessionUsage {
    percentUsed: number;
    resetMinutesOfDay: number;
}

async function verifyViaUsage(bannerMinutes: number): Promise<void> {
    const usage = await readSessionUsage();
    if (usage === null) {
        usageRetryUntil = Date.now() + USAGE_RETRY_COOLDOWN_MS;
        log('Could not read the Current session block from /usage — will retry after backoff');
        return;
    }
    log(`/usage read: session ${usage.percentUsed}% used, resets at minutes-of-day ${usage.resetMinutesOfDay}`);
    if (usage.percentUsed < USAGE_CONFIRM_PCT) {
        disprovedResetMinutes = bannerMinutes;
        disprovedAt = Date.now();
        log('Session below 100% — banner is stale, ignoring this reset from now on');
        return;
    }
    startCountdown(usage.resetMinutesOfDay, bannerMinutes);
}

// Open the /usage panel and read the "Current session" block. When the window
// is too small to show the whole block, scroll the panel one step at a time and
// keep reading until both the percentage and the reset time have been seen.
// Always closes the panel (Esc) before returning.
async function readSessionUsage(): Promise<SessionUsage | null> {
    ptyProcess.write(CLEAR_INPUT_SEQUENCE + USAGE_COMMAND);
    await sleep(USAGE_MENU_SETTLE_MS);
    ptyProcess.write('\r');
    await sleep(USAGE_RENDER_DELAY_MS);

    let seenHeading = false;
    let percentUsed: number | null = null;
    let resetMinutesOfDay: number | null = null;
    let previousScreen: string | null = null;

    for (let step = 0; step <= USAGE_MAX_SCROLL_STEPS; step++) {
        const screen = captureScreen();
        logScreen(screen, `/usage screen (scroll step ${step})`);

        // A scroll that changed nothing means we're at the bottom of the panel;
        // whatever we haven't found by now isn't there.
        if (screen === previousScreen) {
            log('/usage screen unchanged after scroll — reached the bottom');
            break;
        }
        previousScreen = screen;

        // Only text between "Current session" and the next section counts: the
        // weekly rows below also say "% used" and must never be picked up. Once
        // the heading has scrolled off the top, the block's remaining lines are
        // at the top of the panel, so the whole screen becomes the region.
        let region: string | null = null;
        const headingIdx = screen.toLowerCase().indexOf(USAGE_SESSION_HEADING);
        if (headingIdx !== -1) {
            seenHeading = true;
            region = screen.slice(headingIdx);
        } else if (seenHeading) {
            region = screen;
        }
        if (region !== null) {
            const nextIdx = region.toLowerCase().indexOf(USAGE_NEXT_HEADING);
            if (nextIdx !== -1) region = region.slice(0, nextIdx);
            if (percentUsed === null) {
                const m = region.match(usagePercentRegex);
                if (m) percentUsed = parseInt(m[1]!, 10);
            }
            if (resetMinutesOfDay === null) {
                const m = region.match(usageResetRegex);
                if (m) resetMinutesOfDay = resetMinutes(m);
            }
            if (percentUsed !== null && resetMinutesOfDay !== null) break;
        }

        if (step < USAGE_MAX_SCROLL_STEPS) {
            ptyProcess.write(USAGE_SCROLL_KEY);
            await sleep(USAGE_SCROLL_DELAY_MS);
        }
    }

    // log("Closing the window")
    // ptyProcess.write(USAGE_CLOSE_KEY);
    // ptyProcess.write(USAGE_CLOSE_KEY);
    // await sleep(USAGE_CLOSE_DELAY_MS);
    // ptyProcess.write(' \x08');
    // await sleep(200);
    // log("Window closed")

    log("Closing the window")
    ptyProcess.write(USAGE_CLOSE_KEY);
    await sleep(100);
    ptyProcess.write('\x1b[<35;1;1M');
    await sleep(USAGE_CLOSE_DELAY_MS);
    log("Window closed")

    if (percentUsed === null || resetMinutesOfDay === null) return null;
    return { percentUsed, resetMinutesOfDay };
}

// The countdown target comes from /usage; the banner's own reset time is kept
// separately because the *banner* is what re-appears on screen — the repeat
// guard in detectLimit compares against it.
function startCountdown(targetMinutesOfDay: number, bannerMinutes: number): void {
    isWaiting = true;

    // Remember this reset (and when we found it) so the same banner re-appearing
    // after we resume doesn't trigger a second countdown (see detectLimit).
    lastResetMinutes = bannerMinutes;
    lastFoundAt = Date.now();

    // A real limit ends the disproof: whatever banner we'd written off belongs to
    // a session that's over, so the next one gets verified again.
    disprovedResetMinutes = null;
    disprovedAt = 0;
    usageRetryUntil = 0;

    // From here on the title is ours; restoreTitle() hands it back.
    titleOverridden = true;

    const hours = Math.floor(targetMinutesOfDay / 60);
    const minutes = targetMinutesOfDay % 60;

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
                setTitle('⏳ Claude Resumes: waiting for your answer');
                return;
            }
            clearInterval(countdownInterval!);
            countdownInterval = null;
            isWaiting = false;
            // Hand the title back to Claude and resume the session.
            restoreTitle();
            log('Timer elapsed — sending "continue" to resume');
            ptyProcess.write(CLEAR_INPUT_SEQUENCE + 'continue\r');
        } else {
            const totalSeconds = Math.floor(remainingMs / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            const timeStr = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
            setTitle(`⏳ Claude Resumes: ${timeStr}`);
        }
    }, 1000);
}

// Cancel an in-progress countdown (triggered by F4). Clears the remembered reset
// and the time we found it, so the very same limit can be detected again.
function cancelCountdown(): void {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    restoreTitle();
    isWaiting = false;
    lastResetMinutes = null;
    lastFoundAt = 0;
    disprovedResetMinutes = null;
    disprovedAt = 0;
    usageRetryUntil = 0;
    log('Countdown cancelled (F4) — reset cleared, detection re-armed');
}

