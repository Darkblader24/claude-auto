# claude-auto

A thin [node-pty](https://github.com/microsoft/node-pty) wrapper around the
`claude` CLI. It spawns `claude` in a pseudo-terminal and transparently forwards
your input and Claude's output, so the TUI behaves exactly as normal.

Output is also mirrored into a headless [xterm](https://github.com/xtermjs/xterm.js)
terminal. In debug mode the wrapper snapshots that **rendered screen** (the grid
of characters actually on screen, not the raw escape-sequence stream) every
2 seconds and appends it to a log file.

> This is the minimal base. The previous auto-resume-on-limit logic
> (`auto-claude.old.ts`) is kept for reference and will be rebuilt on top of this.

## Install

```bash
bun install
```

## Run

```bash
bun run claude
```

(or `bunx tsx auto-claude.ts`). On Windows you can also use `claude-auto.cmd`.

### Debug logging

Pass `--debug` (or `-d`) to append a snapshot of the rendered screen to
`claude-auto.log` in the working directory every 2 seconds. Without the flag,
nothing is logged. Nothing is ever written to stdout/stderr (that would corrupt
the TUI).

```bash
bun run claude -- --debug
# or
bunx tsx auto-claude.ts --debug
```

## TODO (known, not yet done)

- **Auto-resume**: re-add limit detection + countdown on top of this base
  (see `auto-claude.old.ts`), driven by the captured screen instead of the raw
  output stream.
- **Portability**: `claude-auto.cmd` hard-codes an absolute path.
- **Type-checking**: the run path uses `tsx` (transpile only); `tsc` is not wired
  up, so there is no type-check step.