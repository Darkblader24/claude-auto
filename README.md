<div align="center">

# claude-auto
![⏳ Claude Resumes: 2h 14m 08s](https://i.imgur.com/2braByb.gif)

**Hit your session limit? Go do something else.**
<br>
`claude-auto` automatically waits out the reset and picks up right where you left off.


[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)

---

`claude-auto` is a transparent wrapper around the [Claude Code](https://claude.com/claude-code)
CLI. It runs `claude` inside a pseudo-terminal and forwards your keystrokes and
Claude's output untouched, so the TUI looks and behaves **exactly** as it always has.

The difference: when Claude reports that you've hit your session limit, `claude-auto` sends
a quick `/usage` command to confirm the limit, counts it down in your window title, and sends `continue` 
the moment your quota is back. No babysitting, no lost context.

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
start than a global install (and they can't be aliased to `claude`).

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

Keeping current matters more here than for most tools: limit detection reads
Claude Code's on-screen wording, so if that wording changes, an outdated copy
quietly stops auto-resuming.

## Usage

`claude-auto` is a **drop-in replacement** for `claude`. All user arguments are forwarded directly to the real CLI:

```bash
claude-auto                         # same as `claude`
claude-auto -p "explain this"       # same as `claude -p "explain this"`
claude-auto --permission-mode auto  # same as `claude --permission-mode auto`
```

So the only change to your workflow is the command you type. You can alias it and forget
it's there:

```
# bash
alias claude=claude-auto

# powershell
Set-Alias claude claude-auto

# bat
doskey claude=claude-auto $*
```


### Always starting in auto mode

Set `CLAUDE_AUTO_PERMISSION_MODE` and every session starts in that mode.
`claude-auto` forwards it as `--permission-mode <mode>`. Restart your terminal after setting it:

```
# bash:
export CLAUDE_AUTO_PERMISSION_MODE=auto

# powershell
$env:CLAUDE_AUTO_PERMISSION_MODE = 'auto'
```

Unset the variable to turn it off.


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

`claude-auto` owns exactly one flag. It's namespaced with `--auto-` so it can
never collide with a real `claude` flag, and it's stripped before forwarding.

| Flag           | Effect                                                                        |
|:---------------|:------------------------------------------------------------------------------|
| `--auto-debug` | Append rendered-screen snapshots and detection decisions to `claude-auto.log` |

### Environment variables

| Variable                      | Effect                                                           |
|:------------------------------|:-----------------------------------------------------------------|
| `CLAUDE_AUTO_PERMISSION_MODE` | Start every session in this permission mode                      |
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
bun run build           # emit dist/auto-claude.js
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

Notes:

- The installed binary is always `claude-auto`, independent of the package name.
- npm cannot rename a published package. If you outgrow the name, publish under
  the new one and `npm deprecate <old> "moved to <new>"`.
- The unscoped name `claude-auto` was published and unpublished by someone on
  2026-04-26. npm blocks reuse of unpublished names, which is why the package is
  scoped.
- [Provenance](https://docs.npmjs.com/generating-provenance-statements) is off
  because it requires a public repo. If you make this repo public, add
  `--provenance` to the publish step and `id-token: write` to the job's
  `permissions`.


</details>
