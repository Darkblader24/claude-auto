# claude-auto

A thin [node-pty](https://github.com/microsoft/node-pty) wrapper around the
`claude` CLI. It spawns `claude` in a pseudo-terminal and transparently forwards
your input and Claude's output, so the TUI behaves exactly as normal.

Output is also mirrored into a headless [xterm](https://github.com/xtermjs/xterm.js)
terminal. In debug mode the wrapper snapshots that **rendered screen** (the grid
of characters actually on screen, not the raw escape-sequence stream) every
2 seconds and appends it to a log file.

## Auto-resume on session limit

The wrapper snapshots the rendered screen every 2 seconds and watches it for
Claude's "hit your session limit … resets 4pm" banner. When it sees one:

1. If Claude is showing the "Stop and wait for limit to reset" menu, it presses
   Enter to select it.
2. Otherwise it sends a `continue` probe and re-checks the screen. Only limit
   text appearing *below* that probe counts, so a stale banner scrolled up in
   history can't trigger a false positive.
3. On confirmation it counts down to the reset time (plus a 1 minute buffer),
   showing the remaining time in the window title, then sends `continue` to
   resume the session.

Press **F4** during a countdown to cancel it and re-arm detection. Detection is
skipped entirely while you're scrolled up through history.

## Install

> Not published yet — see [Publishing](#publishing).

```bash
bun add -g claude-auto
# or
npm install -g claude-auto
```

## Run

`claude-auto` is a drop-in replacement for `claude`. Every argument it doesn't
recognise is forwarded verbatim to the real CLI:

```bash
claude-auto                       # same as `claude`
claude-auto --resume              # same as `claude --resume`
claude-auto -p "explain this"     # same as `claude -p "explain this"`
```

Its own flags are namespaced with `--auto-` so they can never collide with
claude's, and they are stripped before forwarding.

| Flag | Effect |
| --- | --- |
| `--auto-debug` | Append rendered-screen snapshots to `claude-auto.log` |

### Debug logging

Pass `--auto-debug` to append a snapshot of the rendered screen to
`claude-auto.log` in the working directory every 2 seconds, along with what the
limit detection decided. Without the flag, nothing is logged. Nothing is ever
written to stdout/stderr (that would corrupt the TUI).

```bash
claude-auto --auto-debug
```

## Development

```bash
bun install
bun run claude          # run from source via tsx
bun run typecheck       # tsc --noEmit (the run path uses tsx, which only transpiles)
bun run build           # emit dist/auto-claude.js
```

On Windows, `claude-auto.cmd` runs the local source without installing.

## Publishing

Releases are cut by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on every push to `main`, but only when `version` in `package.json` changes — an
ordinary push is a no-op. Publishing is currently **disabled** by `"private": true`.

To arm it:

1. **Pick the npm name.** It lives in exactly one place: the `name` field of
   `package.json`. Nothing else — not the workflow, not the `bin` name, not the
   docs beyond this file — depends on it. A scoped name (`@scope/claude-auto`)
   works unchanged; the workflow already passes `--access public`.
2. **Remove `"private": true`** from `package.json`.
3. **Add an npm automation token** as a repo secret:
   `gh secret set NPM_TOKEN`.
4. **Bump `version`** (e.g. to `0.1.0`) and push to `main`.

The workflow then type-checks, builds, publishes to npm, tags `v<version>`, and
creates a GitHub Release with generated notes.

Notes:

- The installed binary is always `claude-auto`, independent of the package name.
- npm cannot rename a published package. If you outgrow the name, publish under
  the new one and `npm deprecate <old> "moved to <new>"`.
- npm [provenance](https://docs.npmjs.com/generating-provenance-statements) is
  not enabled because it requires a public repo. Add `--provenance` to the
  publish step (and `id-token: write` to the job's `permissions`) if you make
  this repo public.