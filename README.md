<div align="center">

# claude-auto
![⏳ Claude Resumes: 2h 14m 08s](https://i.imgur.com/2braByb.gif)

**Hit your session limit? Go do something else.**
<br>
`claude-auto` automatically waits out the reset and picks up right where you left off.


[![npm](https://img.shields.io/npm/v/@hotox/claude-auto.svg)](https://www.npmjs.com/package/@hotox/claude-auto)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

`claude-auto` is a transparent wrapper around the [Claude Code](https://claude.com/claude-code)
CLI. It runs `claude` inside a pseudo-terminal and forwards your keystrokes and
Claude's output untouched, so the TUI looks and behaves **exactly** as it always has.

The difference: when Claude reports that you've hit your session limit, `claude-auto` sends
a quick `/usage` command to confirm the limit, counts it down in your window title, and sends `continue` 
the moment your quota is back. No babysitting, no lost context.

The package is published to npm as [`@hotox/claude-auto`](https://www.npmjs.com/package/@hotox/claude-auto).

---
</div>


## Install

```bash
npm install -g @hotox/claude-auto
```

<details>
<summary>More package managers</summary>

```bash
bun add -g @hotox/claude-auto
pnpm add -g @hotox/claude-auto
yarn global add @hotox/claude-auto
```

</details>

Or run it without installing anything — handy for trying it once:

```bash
npx @hotox/claude-auto      # or: bunx @hotox/claude-auto
```

Note that `npx`/`bunx` re-resolve the package on each run, so they're slower to
start than a global installation, and they can't be aliased to `claude`, but it uses the
latest version of `claude-auto` on every run.


### Updating

npm never updates a global install on its own, so you stay on the version you
installed until you say otherwise:

```bash
npm install -g @hotox/claude-auto@latest
```

`claude-auto` checks for a new version once a day in the background and, if one
exists, prints a one-line reminder **after Claude exits** — never during a
session, where it would corrupt the TUI. Set `CLAUDE_AUTO_NO_UPDATE_CHECK=1` to
turn the check off entirely.


## Usage

`claude-auto` is a **drop-in replacement** for `claude`. All user arguments are forwarded directly to the real CLI:

```bash
claude-auto                         # same as `claude`
claude-auto -p "explain this"       # same as `claude -p "explain this"`
claude-auto --permission-mode plan  # same as `claude --permission-mode plan`
```

### Aliasing it to `claude`

To make `claude` always start `claude-auto` automatically:

```bash
claude-auto --install-alias     # --uninstall-alias to undo it
```

It writes the alias into your shell's startup file (`~/.zshrc`, `~/.bashrc`,
`config.fish`, PowerShell's `$PROFILE`. it picks the right one and tells you
which), so every new shell has it. Safe to re-run. Open a new shell afterwards.

Not supported for `cmd.exe`: `doskey` has no startup file, so a permanent macro
needs a registry key that runs for every `cmd` session on the machine. Use
PowerShell.


### Auto mode

`claude-auto` sessions start automatically in auto mode. A wrapper whose whole
job is to keep working while you're away shouldn't then stop to ask permission
for every tool call, so `claude-auto` passes `--permission-mode auto` for you.

Here are three ways to override this:

```
claude-auto --no-auto-mode                   # starts Claude using the default mode
claude-auto --permission-mode plan           # starts in any mode (here in plan mode)
claude-auto --dangerously-skip-permissions
```


### Cancelling a countdown

Press <kbd>F4</kbd> while a countdown is running to cancel it and hand the
session back to you. Detection re-arms immediately, so the same limit can be
picked up again.
- On macOS, <kbd>F4</kbd> is a system key unless `Use F1, F2, etc. keys as
  standard function keys` is enabled in Settings, so countdown cancelling may
  not reach the wrapper.


## License

[MIT](LICENSE) © Philipp Köhler

---

<details>
<summary>Dev Notes</summary>

### Flags

`claude-auto` owns these flags. None of them reach `claude`; everything else you
pass goes to it verbatim.

| Flag                | Effect                                                                           |
|:--------------------|:---------------------------------------------------------------------------------|
| `--no-auto-mode`    | Don't pass `--permission-mode auto`. Makes it start in claude's own default mode |
| `--install-alias`   | Write `claude` → `claude-auto` into your shell's startup file                    |
| `--uninstall-alias` | Remove that alias again                                                          |
| `--auto-debug`      | Append rendered-screen snapshots and detection decisions to `claude-auto.log`    |

The first two are stripped before forwarding and the session runs as usual. The
alias flags don't start a session at all: they edit the file, report what they
did, and exit.

### Environment variables

| Variable                      | Effect                                                           |
|:------------------------------|:-----------------------------------------------------------------|
| `CLAUDE_AUTO_NO_UPDATE_CHECK` | Set to `1` to disable the daily update check and the exit notice |

## How auto-resume works

Every 2 seconds, `claude-auto` snapshots the **rendered screen**, the grid of
characters actually on display, mirrored into a headless
[xterm](https://github.com/xtermjs/xterm.js), rather than the raw escape-sequence
stream. That means it sees what you see, and isn't fooled by redraws, spinners,
or partial writes.

When a session-limit banner appears:

1. **If Claude is offering its "Stop and wait for limit to reset" menu**, it
   selects that option for you.
2. **Otherwise it confirms the limit against `/usage`.** It opens Claude's
   `/usage` panel and reads the *Current session* blocks percent used and reset
   time. Only a bar at **100% used** confirms the limit, so a stale banner on
   screen can't trigger a false positive. If the window is too small to show the
   block, the panel is scrolled step by step until both values have been read.
   Then the panel is closed with Esc.
3. **Then it waits.** It counts down to the reset time reported by `/usage`
   (plus a one-minute safety buffer) — more precise than the rounded time in the
   banner — showing the remaining time in your window title, and sends
   `continue` when the clock runs out.

Some more details:

- Detection is skipped entirely while you're scrolled up through history, what's
  on screen there is stale.
- Nothing is typed while Claude is asking whether to resume a long session *from
  a summary* ("Resume from summary (recommended)" / "Resume full session
  as-is"). If a countdown runs out while the question is up, `claude-auto` holds 
  and resumes the moment you've answered.
- A reset that's already been counted down to is ignored if the same banner
  reappears, until enough time has passed that it must be a genuinely new limit.
- A banner that `/usage` disproves (session below 100%) is remembered by its reset
  time and is ignored until a real limit is hit, or after 3 hours, whichever
  comes first.
- The weekly rows in `/usage` also say "% used", but only text between the
  *Current session* heading and the next section is ever parsed, so they can't
  be mistaken for the session bar.
- Nothing is ever written to stdout or stderr. That would corrupt the TUI, so all
  diagnostics go to the optional log file.

## Development

```bash
bun install
bun run claude          # run from source via tsx
bun run typecheck       # tsc --noEmit
bun run build           # emit dist/claude-auto.js
```

The run path uses [`tsx`](https://github.com/privatenumber/tsx), which transpiles
without type-checking, so `bun run typecheck` is a separate step.

On Windows, `claude-auto.cmd` runs the local source without installing anything.                                 |

## Publishing

The package is published to npm as [`@hotox/claude-auto`](https://www.npmjs.com/package/@hotox/claude-auto).

Releases are cut by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on every push to `main`, but **only when `version` in `package.json` changes**,
an ordinary push is a no-op. To cut a release, bump `version` and push to `main`.
The workflow type-checks, builds, publishes to npm, tags `v<version>`, and creates
a GitHub Release with generated notes.

It needs an npm automation token in the repo secret `NPM_TOKEN` (`gh secret set NPM_TOKEN`).

</details>
