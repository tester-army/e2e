# @e2edev/tmux

The terminal backend for [`e2e`](https://www.npmjs.com/package/@e2edev/e2e):
CLIs and full-screen TUIs (OpenCode, vim, lazygit, htop, your own `node
dist/cli.js`) running in [tmux](https://github.com/tmux/tmux), through the
same `@e2edev/e2e/backend` contract the browser and mobile backends implement.
A test written against `screen`, `expect`, `app`, and `agent` runs on a
terminal target unchanged; nothing in `e2e` core knows this package exists.

## Install

```bash
npm install --save-dev @e2edev/e2e @e2edev/tmux
```

tmux 3.2 or newer must be on `PATH` (`brew install tmux`, `apt install tmux`),
or named through the `tmuxPath` option. The runner checks once per run,
before any test starts.

```ts title="e2e.config.ts"
import { defineConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { tmux } from '@e2edev/tmux';
import { tmuxTools } from '@e2edev/tmux/tools';

const opencode = tmux({ command: 'opencode', cwd: './fixtures/workspace', ready: 'Ask anything' });

export default defineConfig({
  targets: [{ name: 'opencode', platform: 'terminal', backend: opencode }],
  workers: 1,
  agent: { executor: createAgent({ tools: tmuxTools(opencode) }) },
});
```

```ts
import { test } from '@e2edev/tmux';
import { expect } from '@e2edev/e2e';

test('opens the command palette', async ({ screen, terminal }) => {
  await terminal.type('/');
  await expect(screen.getByText('/help')).toBeVisible();
  await terminal.press('Escape');
  await expect(screen.getByText('/help')).not.toBeVisible();
});

test('writes a file when asked', async ({ agent, terminal }) => {
  await agent.act('ask OpenCode to create hello.txt containing "hi" and wait until it is done');
  expect(existsSync(path.join(terminal.cwd, 'hello.txt'))).toBe(true);
});
```

Options:

| Option | Meaning |
| --- | --- |
| `command` | Shell command started fresh in its own tmux window at the start of every attempt. Runs through tmux's default shell, so quoting and pipes work as at a prompt. |
| `cwd` | Working directory of the program, resolved against the project root (the config's directory). Default: the project root. |
| `env` | Environment variables added to the program's environment. |
| `columns`, `rows` | Pane size in cells. Default `120` by `40`. |
| `ready` | Text (or regular expression) a row must show before the attempt starts. Without it the attempt starts once the screen holds still. Both are bounded by the launch timeout. |
| `session` | tmux session name; defaults to `e2e-<target name>`. |
| `tmuxPath` | The tmux binary; defaults to `tmux` on `PATH`. |

## What the backend declares

- **Observation**: the pane text. One `application` root named after the
  pane title (or the program), and one `text` node per printed column: a row
  is split at runs of two or more spaces, the way TUIs draw columns (`/help
  Help`, `[ Yes ]   [ No ]`), so each column has its own rect in cells (`y`
  is the row, `x` the column) and `getByText('/help')` names the command
  exactly. A row with several columns is wrapped in a nameless `row`; pure
  decoration (box drawing, rulers) is dropped. The column under a visible
  cursor is a focused `textbox`, which is where typing lands. When the
  program exits, the root is `disabled` and a `status` node reports the exit
  status; the final screen stays observable. String queries are exact, as
  everywhere in `e2e`: match part of a column with a regular expression or
  `{ exact: false }`.
- **Actions**: `fill` types the value literally (nothing is submitted until
  `Enter`), `press` accepts browser key names (`Enter`, `Escape`, `ArrowDown`,
  `Backspace`, `Control+C`, `Shift+Tab`) and tmux chords (`C-c`, `M-x`), `tap`
  and `doubleTap` write an SGR mouse click into the pane at the middle of the
  row for programs that turned mouse reporting on and are `NOT_ACTIONABLE`
  otherwise (a program not reading the mouse would see the bytes as typed
  text), `swipe` sends wheel reports or `PageUp`/`PageDown`, `focus` is a
  no-op (the keyboard is the one input). `clear`, `check`, `hover`,
  `selectOption`, `setInputFiles`, `dragTo`, and `scrollIntoView` are
  `UNSUPPORTED_CAPABILITY`.
- **Location**: `getByText` and `getByLabel` for any column, `getByRole` for
  the roles in the typed vocabulary (`textbox` for the cursor column, `status`
  for the exit line), filters, and `first`/`last`. `text`, `row`, and
  `application` nodes are reached by text, not by role. No selector language
  and no frames.
- **App**: `restart()` replaces the program's window with a fresh one. No
  `navigate`, `back`, or `clearState`; no `state` capability; no `artifacts`
  (a screenshot of a terminal is its text, and `terminal.text()` reads it).
- **`url`**: `app://terminal/<program>/<pane title>`, the trace cache's anchor.

## Lifecycle

`prepare` runs `tmux -V` once per run and fails the run with
`TMUX_UNAVAILABLE` when tmux is missing. `init` starts a private tmux server
on a per-run socket (`-L e2e-<run id>`), never the developer's own, with one
session per worker holding a placeholder window; it sets `remain-on-exit`
so a program that exits leaves its final screen, turns the status bar off so
it never appears in a capture, and pins the window size so an attached
viewer cannot resize it. Each attempt opens a new window running `command`
in `cwd` with `env`, waits for `ready` (or a still screen), and kills the
window when the attempt ends. `dispose` kills the session.

Run with `--headed` on macOS to have a Terminal.app window attach to the
session and watch the run type. Elsewhere, attach by hand while a run is
live:

```bash
tmux -L e2e-<run id> attach-session -t e2e-<target name>
```

## The `terminal` fixture

Deterministic terminal control, recorded as `terminal.<method>` steps.
Import `test` from this package to have it typed.

| Member | Meaning |
| --- | --- |
| `cwd` | Absolute working directory of the program, for checks on files it writes. |
| `text()` | The visible screen, rows joined by newlines. |
| `scrollback(lines?)` | History plus the screen, newest `lines` rows (default 200). |
| `type(text)` | Types literally, without pressing Enter. |
| `press(key)` | One key by browser name or tmux chord. |
| `send(...keys)` | tmux key names in order: `send('C-x', 'C-c')`. |
| `waitForText(pattern, { timeout? })` | Resolves with the first matching row. |
| `waitForExit({ timeout? })` | Resolves with the exit status once the program ends. |
| `exited()` | Whether the program has ended. |
| `resize(columns, rows)` | Resizes the pane. |
| `cursor()` | Zero-based cursor cell. |
| `title()` | The program's own title for the pane. |

## Agent tools

`@e2edev/tmux/tools` exports `tmuxTools(...backends)`: `send_keys` (a
sequence of tmux keys or chords in one move, `["/", "help", "Enter"]`),
`wait_for_text` (wait for a row instead of observing in a loop), and
`scrollback` (history that scrolled off screen). Pass every terminal backend
the config declares; tools are scoped to the `terminal` platform, so a suite
that mixes web and terminal targets can hand one pack to one `createAgent`.

## Trace cache

The runner caches `agent.act` steps by their location anchor, and a terminal
has no address bar. This backend reports one anyway:
`app://terminal/<program>/<pane title>`. Programs that set the terminal title
(OpenCode, vim with `title` on) get an anchor per screen; a program that does
not gets one per program. A flow that stays within type, press, and tap
replays with zero model calls on the next run.

## Secrets

A terminal has no field to fill and no origin to check, so `type_secret` is
denied on a terminal target before any plaintext reaches the pane. Provide
credentials to the program through `env` or its own configuration instead.

## Documentation

Full documentation lives at
[e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com/reference/terminal).
