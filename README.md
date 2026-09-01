<div align="center">

# claude-auto: auto-continue for Claude Code
![⏳ Claude Resumes: 2h 14m 08s](https://i.imgur.com/2braByb.gif)

**Hit your session limit? Go do something else.**
<br>
`claude-auto` automatically waits out the reset and continues right where you left off.


[![npm](https://img.shields.io/npm/v/@hotox/claude-auto.svg)](https://www.npmjs.com/package/@hotox/claude-auto)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

`claude-auto` is a transparent wrapper around the [Claude Code](https://claude.com/claude-code)
CLI. It runs `claude` inside a pseudo-terminal and forwards your keystrokes and
Claude's output untouched, so the TUI looks and behaves **exactly** as it always has.

The difference: when Claude stops — because you've hit a usage limit (session,
weekly, or monthly spend), or because it parked the session at a **checkpoint**
just short of one — `claude-auto` sends a quick `/usage` command to confirm it,
counts the wait down in your window title, and sends `continue`
the moment your quota is back. And where Claude offers `/low-priority` — keep
going now, on spare capacity — it takes that instead of waiting at all. No
babysitting, no lost context.

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

A **limit banner** is any of the wordings Claude uses to say you're out of quota —
"You've hit your session limit ∙ resets 11:50am", "You've hit your weekly limit" and
"You've hit your monthly spend limit" today. They're aliases of each other: whichever appears, the handling below is
identical. New wordings are a one-line addition to `LIMIT_PATTERNS` in `claude-auto.ts`.

When a limit banner appears:

1. **If Claude is offering its "Stop and wait for limit to reset" menu**, it
   selects that option for you.
2. **If Claude is offering `/low-priority`**, it takes the offer instead of
   waiting. Newer Claude Code builds print a line beneath the limit —
   `⚠ /low-priority to continue now at lower priority · uses your weekly limit` —
   and where that's on screen there's nothing to wait for: `claude-auto` submits
   the command and the session carries straight on, out of your weekly quota. No
   `/usage` read either, since the offer is only ever printed beside a limit
   that's blocking right now. The command is a *toggle*, so it's only ever sent
   once per limit: Claude's echo of it (`❯ /low-priority`) marks everything above
   it as handled, exactly the way the `continue` from a countdown does.
3. **Otherwise it confirms the limit against `/usage`.** It opens Claude's
   `/usage` panel and reads the two bars that can stop a session: *Current
   session* and *Current week (all models)*, each one's percent used and reset
   time. Only a bar at **100% used** confirms the limit, so a stale banner on
   screen can't trigger a false positive — and a banner is only written off as
   stale when *neither* bar is spent. If the window is too small to show both
   blocks, the panel is scrolled step by step until they've been read. Then the
   panel is closed with Esc.
4. **Then it waits.** It counts down to the reset time reported by `/usage`
   (plus a one-minute safety buffer) — more precise than the rounded time in the
   banner, and the only source when the banner carries no time at all — showing
   the remaining time in your window title, and sends `continue` when the clock
   runs out. When both bars are spent it waits for the later of the two, since
   resuming while the weekly quota is still gone would only hit the limit again.

**Checkpoints** are the other way a session stops. Rather than running you into
the hard limit, Claude now usually stops near the top of the window and writes a
line like `● Checkpoint …`; the older `● Claude usage limit reached` wording has
the same shape. Any line that *starts* with the assistant bullet and carries one
of the phrases in `CHECKPOINT_PHRASES` (`checkpoint`, `usage limit` today) counts
as one — adding a wording is a one-line change there.

A checkpoint runs through everything above unchanged — the same staleness test,
the same `/low-priority` shortcut, the same disproof memo, the same `/usage`
panel read, the same countdown — with
one difference: it fires *before* the session is spent, so the 100% rule would
never confirm it. The **Current session** bar only has to read **95% used**
(`CHECKPOINT_CONFIRM_PCT`). Below that, the line is written off as stale and
ignored, exactly like a disproved banner. The weekly bar still has to read 100%,
so a week sitting at 96% can't park the wrapper for days over a limit that isn't
blocking anything.

Because the phrase only has to appear on a bulleted line, a tool call that
happens to mention it (`● Bash(grep -n "checkpoint" …)`) is a possible false
positive. It costs one `/usage` check, which disproves it — and the disproof is
remembered, so it stays quiet from then on.

**Overload errors** (`● API Error: 529`) are handled the same way, minus the
verification: there's no quota involved, so there's nothing `/usage` could
confirm. `claude-auto` just counts down five minutes and sends `continue`. If the
error comes back, so does the countdown. A limit banner and a checkpoint both
take precedence — when you're out of quota, retrying in five minutes would only
hit the limit again.

Some more details:

- Detection is skipped entirely while you're scrolled up through history, what's
  on screen there is stale.
- Nothing is typed while Claude is asking whether to resume a long session *from
  a summary* ("Resume from summary (recommended)" / "Resume full session
  as-is"). If a countdown runs out while the question is up, `claude-auto` holds 
  and resumes the moment you've answered.
- A limit banner with either of the things we send below it — the `continue` from
  a countdown, or a `/low-priority` — is scrollback, not a live stop, so it's
  never acted on twice. That's what makes a just-waited-out limit safe to leave on
  screen, with no time window to tune.
- A reset that's already been counted down to is ignored if the same banner
  reappears, until enough time has passed that it must be a genuinely new limit.
- A banner that `/usage` disproves (no bar as full as the threshold that applies
  to it) is remembered — by its kind, its wording, and the reset time it carried
  — and is ignored until a real limit is hit, or after 3 hours, whichever comes
  first. A later banner resetting at a different time is a different banner, so
  it's still checked, and a disproved checkpoint never mutes a limit banner.
- Every row in `/usage` says "% used", so each value is only ever read from the
  section it belongs to and the bars can't be confused for one another. The
  *Current week (Opus)* row is deliberately not treated as a limit: Claude Code
  falls back to Sonnet rather than stopping, so it never blocks a session.
- A session bar at 0% prints no reset line at all — that's expected, not a failed
  read. It just means the session isn't the limit you're waiting on.
- Weekly resets are days out, so they print a date ("Resets Jul 22, 8am") rather
  than a clock time. The year isn't shown; it's taken as the current one, rolling
  into the next when the date is already well behind us. A reset that reads as
  already past still leaves a five-minute gap before resuming, so a just-missed
  reset — or a machine clock offset from the timezone `/usage` prints — can't
  turn into a resume-and-retry spin.
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
