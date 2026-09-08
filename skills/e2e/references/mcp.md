# Driving the app over MCP

`e2e mcp` serves the project's live app to a coding agent over MCP (stdio).
It gives the agent the same hands the testing agent has on the app: look at
a screen before writing a test, and check a locator before committing to it.
Running tests and reading a failed run stay on the CLI (topics `running` and
`debugging`).

## Setup

The server ships with `@e2edev/e2e`. `e2e init` offers to register it; by
hand:

```bash
claude mcp add e2e -- npx --no-install e2e mcp          # Claude Code
```

Or declare it in the client's project config (`.mcp.json` for Claude Code,
`.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code):

```json
{ "mcpServers": { "e2e": { "command": "npx", "args": ["--no-install", "e2e", "mcp"] } } }
```

Flags: `--config <path>` names the config file, `--target <name>` fixes the
target every session opens on, `--headless` hides the browser or simulator
(sessions are headed by default outside CI, so the developer can watch).

## Tools

| Tool | Does |
| --- | --- |
| `open_session` | Starts the declared app command if any, boots the engine, opens the app URL, returns the first observation. `target` is required when the config declares several. One session at a time. |
| `observe` | A fresh observation: one node per line as `#id role "name" ...`, plus the current path. |
| `tap`, `type`, `press`, `select`, `scroll`, `navigate` | The grammar verbs, exactly as the testing agent gets them. Each reports what changed on screen; `observe` shows the whole screen. A verb the engine cannot honor is not offered. |
| `type_secret` | Fills a configured credential's password into a secure field by credential name; the plaintext never reaches the agent. Offered when the config declares `credentials`. |
| `locate` | Tries a semantic locator (`role` + `name`, `text`, `label`, `placeholder`, `testId`, `exact`) and returns how many nodes match, which, and the `screen.*` call to write. |
| `screenshot` | The masked pixels, withheld once a secret was filled in the session. |
| `close_session` | Ends the attempt, disposes the engine, stops the app processes the session started. |

Project tools defined with `defineTool` and passed to `createAgent({ tools })`
are served too, under their own names.

Resources: `e2e://guide` and `e2e://guide/<topic>` hold this skill.

## Workflow

1. `open_session`, then `observe` and act until the screen you want to test is
   in front of you. Node ids are valid only for the newest observation; an
   action reports what changed, so `observe` again before using new ids.
2. `locate` each locator you intend to write. One match: use the printed
   `screen.getByRole(...)` call. Zero or several: adjust before writing the
   test, the same failure would hit the test as `LOCATOR_NOT_FOUND` or
   `LOCATOR_AMBIGUOUS`.
3. Write `tests/<feature>.e2e.ts` (topic `writing-tests`). Deterministic steps
   where you saw exact names; `agent.act` where the flow varies.
4. Run it from the shell: `npx --no-install e2e run tests/<feature>.e2e.ts`,
   read the failure (topic `debugging`), fix, repeat.
5. `close_session` when you are done exploring; an idle session closes on its
   own after 30 minutes and never outlives 4 hours.

## Rules

- Sessions enforce the same policy as tests: navigation stays inside the
  engine's allowed origins, secrets fill only through `type_secret`, and
  pixels are withheld once a secret is on screen.
- Nothing a session does is recorded as a test or into the trace cache. A
  session is for looking and trying; the test is what you write afterwards.
- A run from the shell and a live session can share the app only if the
  engine's `command` uses `reuseExisting`; otherwise close the session before
  running.
- `TARGET_REQUIRED`: pass `target` to `open_session` or start with `--target`.
  `NO_SESSION`: call `open_session` first. `SESSION_OPEN`: one is already
  open; use it or `close_session`.
