<div align="center">

# claude-auto

**Hit your session limit? Go do something else.**
`claude-auto` automatically waits out the reset and picks up right where you left off.

![⏳ Claude Resumes: 2h 14m 08s](https://i.imgur.com/2braByb.gif)

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
npm install -g claude-auto
```

<details>
<summary>More package managers</summary>

```bash
bun add -g claude-auto
pnpm add -g claude-auto
yarn global add claude-auto
```

</details>

## Usage

`claude-auto` is a **drop-in replacement** for `claude`. Anything it doesn't
recognise is forwarded verbatim to the real CLI:

```bash
claude-auto                       # same as `claude`
claude-auto --resume              # same as `claude --resume`
claude-auto -p "explain this"     # same as `claude -p "explain this"`
```

So the only change to your workflow is the command you type. You can alias it and forget
it's there:

```bash
alias claude=claude-auto                 # bash / zsh — add to ~/.bashrc or ~/.zshrc
```

```powershell
Set-Alias claude claude-auto             # PowerShell — add to $PROFILE
```

```bat
doskey claude=claude-auto $*             :: cmd.exe
```

### Flags

`claude-auto` owns exactly one flag. It's namespaced with `--auto-` so it can
never collide with a real `claude` flag, and it's stripped before forwarding.

| Flag           | Effect                                                                        |
|:---------------|:------------------------------------------------------------------------------|
| `--auto-debug` | Append rendered-screen snapshots and detection decisions to `claude-auto.log` |

### Cancelling a countdown

Press <kbd>F4</kbd> while a countdown is running to cancel it and hand the
session back to you. Detection re-arms immediately, so the same limit can be
picked up again.

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
   `/usage` panel and reads the *Current session* block — percent used and reset
   time. Only a bar at **100% used** confirms the limit, so a stale banner on
   screen can't trigger a false positive. If the window is too small to show the
   block, the panel is scrolled step by step until both values have been read.
   Then the panel is closed with Esc.
3. **Then it waits.** It counts down to the reset time reported by `/usage`
   (plus a one-minute safety buffer) — more precise than the rounded time in the
   banner — showing the remaining time in your window title, and sends
   `continue` when the clock runs out.

A few details that keep it honest:

- Detection is skipped entirely while you're scrolled up through history, what's
  on screen there is stale.
- Nothing is typed while Claude is asking whether to resume a long session *from
  a summary* ("Resume from summary (recommended)" / "Resume full session
  as-is"). That question is a select menu, so an Enter would answer it, and the
  default answer compacts your conversation. That choice stays yours. If a
  countdown runs out while the question is up, `claude-auto` holds and resumes
  the moment you've answered.
- A reset that's already been counted down to is ignored if the same banner
  reappears, until enough time has passed that it must be a genuinely new limit.
- A banner that `/usage` disproves (session below 100%) isn't re-checked for
  5 minutes, so the panel doesn't keep popping open over a stale banner.
- The weekly rows in `/usage` also say "% used", but only text between the
  *Current session* heading and the next section is ever parsed, so they can't
  be mistaken for the session bar.
- Nothing is ever written to stdout or stderr. That would corrupt the TUI, so all
  diagnostics go to the log file.

### Debug logging

```bash
claude-auto --auto-debug
```

Writes `claude-auto.log` in the working directory: a screen snapshot every 2
seconds, plus every decision the limit detector made. Without the flag, nothing
is logged.

## License

[MIT](LICENSE) © Philipp Köhler

---

<!-- ─────────────────────────────────────────────────────────────────────────
     Everything below this line is for contributors and maintainers.
     ───────────────────────────────────────────────────────────────────── -->

## Development

```bash
bun install
bun run claude          # run from source via tsx
bun run typecheck       # tsc --noEmit
bun run build           # emit dist/auto-claude.js
```

The run path uses [`tsx`](https://github.com/privatenumber/tsx), which transpiles
without type-checking, so `bun run typecheck` is a separate step.

On Windows, `claude-auto.cmd` runs the local source without installing anything.

### Layout

| Path                            | Purpose                                                        |
|:--------------------------------|:---------------------------------------------------------------|
| `auto-claude.ts`                | The entire wrapper, pty spawn, screen capture, limit detection |
| `tsconfig.json`                 | Type-check config (`noEmit`)                                   |
| `tsconfig.build.json`           | Emit config used by `bun run build`                            |
| `.github/workflows/release.yml` | Publishes on version bump                                      |

## Publishing

Releases are cut by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on every push to `main`, but **only when `version` in `package.json` changes**,
an ordinary push is a no-op. Publishing is currently disabled by
`"private": true`.

To arm it:

1. **Pick the npm name.** It lives in exactly one place: the `name` field of
   `package.json`. Nothing else depends on it, not the workflow, not the binary
   name, nothing but this file. A scoped name (`@scope/claude-auto`) works
   unchanged; the workflow already passes `--access public`.
2. **Remove `"private": true`** from `package.json`.
3. **Add an npm automation token** as a repo secret: `gh secret set NPM_TOKEN`.
4. **Bump `version`** and push to `main`.

The workflow type-checks, builds, publishes to npm, tags `v<version>`, and creates
a GitHub Release with generated notes.

Notes for whoever picks the name:

- The installed binary is always `claude-auto`, independent of the package name.
- npm cannot rename a published package. If you outgrow the name, publish under
  the new one and `npm deprecate <old> "moved to <new>"`.
- The unscoped name `claude-auto` was published and unpublished by someone on
  2026-04-26. npm blocks reuse of unpublished names, so publishing under it will
  fail with a 403 unless you were the original owner.
- [Provenance](https://docs.npmjs.com/generating-provenance-statements) is off
  because it requires a public repo. If you make this repo public, add
  `--provenance` to the publish step and `id-token: write` to the job's
  `permissions`.

### Platform support

- On macOS, <kbd>F4</kbd> is a system key unless *Use F1, F2, etc. keys as
  standard function keys* is enabled in Settings, so countdown cancelling may
  not reach the wrapper.
