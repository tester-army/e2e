---
'@e2edev/tmux': minor
---

New package: `@e2edev/tmux`, the terminal backend for `e2e`. It runs a CLI or
TUI (`opencode`, `vim`, `lazygit`, your own `node dist/cli.js`) in a private
tmux server and implements the public `@e2edev/e2e/backend` contract the same
way `@e2edev/playwright` does for browsers and `@e2edev/agent-device` for
mobile, and core learns nothing new.

- `tmux({ command, cwd?, env?, columns?, rows?, ready?, session?, tmuxPath? })`
  returns a backend handle: one tmux session per worker, one window running
  `command` per attempt, the program's exit kept on screen.
- Observation is the pane text: one `application` root, one `text` node per
  printed column (a row splits at runs of two or more spaces, so `/help` and
  its description, or `[ Yes ]` and `[ No ]`, are separate nodes with their
  own cell rects; a row with several columns is wrapped in a `row`), the
  column under the cursor as a focused `textbox`, an exit `status` node when
  the program ended. `screen` queries answer by text, role, and name.
- Actions: `fill` types literally, `press` accepts browser key names (`Enter`,
  `ArrowDown`, `Control+C`) and tmux chords (`C-c`), `tap` writes an SGR mouse
  click into the pane for programs in mouse mode and is `NOT_ACTIONABLE`
  otherwise, `swipe` sends wheel reports or page keys. `app.restart()`
  relaunches the program. `url` mints `app://terminal/<program>/<title>` so
  the trace cache has an anchor.
- The `terminal` fixture: `text`, `scrollback`, `type`, `press`, `send`,
  `waitForText`, `waitForExit`, `exited`, `resize`, `cursor`, `title`, and the
  `cwd` accessor for checks on files the program writes.
- `@e2edev/tmux/tools` exports `tmuxTools(...backends)`: `send_keys`,
  `wait_for_text`, and `scrollback` for the agent, scoped to the `terminal`
  platform.
- `--headed` on macOS opens a Terminal.app window attached to the session so
  a person can watch the run type.
