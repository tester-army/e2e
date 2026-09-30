# Driving the app over MCP

`e2e mcp` serves a project's live app to a coding agent over MCP (stdio).
It gives the agent the same hands the testing agent has on the app: look at
a screen before writing a test, and check a locator before committing to it.
Running tests and reading a failed run stay on the CLI (topics `running` and
`debugging`).

## Setup

The server ships with `e2e`. `e2e init` offers to register it; by
hand:

```bash
claude mcp add e2e -- npx e2e mcp   # Claude Code
```

Or declare it in the client's project config (`.mcp.json` for Claude Code,
`.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code):

```json
{ "mcpServers": { "e2e": { "command": "npx", "args": ["e2e", "mcp"] } } }
```

Flags: `--config <path>` names the default config file, `--target <name>`
fixes the target every session opens on, `--headless` hides the browser or
simulator (sessions are headed by default outside CI, so the developer can
watch), `--max-sessions <n>` sets how many sessions may be open at once
(default 4, 1 through 16).

## Tools

The server has four tools, and the list never changes. Everything a session
can do is a catalog behind `call`.

| Tool | Does |
| --- | --- |
| `open_session` | Loads the config (`config` names another file; default the nearest `e2e.config.ts`), starts the declared app command if any, boots the engine, opens the app URL, and returns the session id, the catalog, and the first observation. `target` is required when the config declares several. Up to four sessions at once by default (`--max-sessions`), each on its own browser or device. |
| `tools` | The catalog: one line per tool with its argument names (`?` marks optional), the first sentence of its description, and `[read-only]` where it changes nothing. `tools {tool}` shows one tool's full description and the JSON Schema of its arguments. |
| `call` | Runs one catalog tool: `call {tool: "tap", args: {target: "n42"}}`. Arguments are checked against the tool's schema first; a wrong one fails with `INVALID_ARGUMENT` naming the field. |
| `close_session` | Saves a recording still running, ends the attempt, disposes the engine, stops the app processes the session started once no other session uses them. |

The catalog, per session:

| Catalog tool | Does |
| --- | --- |
| `observe` | A fresh observation: one node per line as `#id role "name" ...`, plus the current path. A link's `href` is its path on the app URL's origin, else origin and path (`mailto:`, `tel:`, and `blob:` keep their scheme); `?…` and `#…` mark a dropped query or fragment, `data:…` and `javascript:…` an inline payload, a trailing `…` a target cut at 256 characters. |
| `tap`, `double_tap`, `long_press`, `right_click`, `hover`, `type`, `press`, `select`, `check`, `scroll`, `scroll_to`, `drag`, `upload`, `navigate`, `back` | The grammar verbs, exactly as the testing agent gets them: `check` takes `checked`, `drag` a `to` node, `upload` project-relative `files`. Each reports what changed on screen; `observe` shows the whole screen. A verb the engine cannot honor is not listed and fails with `UNSUPPORTED_CAPABILITY`. |
| `type_secret` | Fills a configured secret by name: a credential's password into a password field, a `secrets` entry into any editable input; the plaintext never reaches the agent. Listed when the config declares `credentials` or `secrets`. |
| `locate` | Tries a semantic locator (`role` + `name`, `text`, `label`, `placeholder`, `testId`, `exact`) and returns how many nodes match, which, and the `screen.*` call to write. |
| `screenshot` | The masked pixels as an image, withheld once a secret was filled in the session. |
| `tap_at` | Taps a point (`x`, `y` in the latest screenshot's pixels): a listed control under it by id, otherwise the bare point, which an engine without a bare-point tap cannot do. Listed when the engine declares `tap` or a bare-point tap. |
| `hover_at` | Hovers a point the same way: a listed control under it by id, otherwise the bare point. Listed when the engine declares `hover` or a bare-point hover. |
| `type_at` | Types `value` into the field at a point: a listed input under it is filled by id; with a keyboard, anything else is tapped to focus it and typed into, at the caret unless `replace` is set. Without a keyboard a point on nothing listed fails. Listed when the engine declares `type` or a keyboard. |
| `press_at` | Sends one `key` (`Enter`, `Escape`, `Tab`) to the control at a point: a listed control gets it by id; with a keyboard, anything else is tapped to focus it and the key goes through the keyboard. Listed when the engine declares `press` or a keyboard. |
| `select_at` | Picks the option whose visible label is `value` in the select-like control at a point; the point must land on a listed select. Listed when the engine declares `select`. |
| `start_recording` | Starts a video of the app (`name` optional, for the file name). Listed when the engine records video. |
| `stop_recording` | Stops it and returns the absolute path of each video file, under `<output>/videos/<session>/` (`.e2e` by default), or the URL of a provider's own recording. |
| `new_email_address`, `wait_for_email` | With `email` in the config: a new address for the session, and the next email to it, fenced as untrusted with secrets masked. The addresses go back when the session closes. |
| Project tools | Every `defineTool` in the agent's `tools` that applies to the target's platform, under its own name; an engine pack such as `mobileTools` adds `open_app`, `swipe`, `alert`. |

The five point tools and `screenshot` stay in the catalog once a secret has
been filled in the session, and answer `PIXEL_TAINTED` for the rest of it.
Before the session's first `screenshot` each point tool answers with the line
that says to take one, at no cost.

Resources: `e2e://guide` and `e2e://guide/<topic>` hold this skill.

## Workflow

1. `open_session`, then `call {tool: "observe"}` and act until the screen you
   want to test is in front of you. Node ids are valid only for the newest
   observation; an action reports what changed, so observe again before
   using new ids. The opening text lists every tool with its arguments;
   `tools {tool}` when you need the full contract.
2. `call {tool: "locate", args: {...}}` for each locator you intend to write.
   One match: use the printed `screen.getByRole(...)` call. Zero or several:
   adjust before writing the test, the same failure would hit the test as
   `LOCATOR_NOT_FOUND` or `LOCATOR_AMBIGUOUS`.
3. Write `tests/<feature>.e2e.ts` (topic `writing-tests`). Deterministic steps
   where you saw exact names; `agent.act` where the flow varies.
4. Run it from the shell: `npx e2e run tests/<feature>.e2e.ts`,
   read the failure (topic `debugging`), fix, repeat.
5. `close_session` when you are done exploring; an idle session closes on its
   own after 30 minutes and never outlives 4 hours. When the client exits,
   every session closes and the app commands stop. To look at another
   project or config, `open_session {config: "path/to/e2e.config.ts"}`; no
   restart needed.

## Rules

- Sessions enforce the same policy as tests: secrets fill only through
  `type_secret`, and screenshots are withheld once a secret is on screen.
- Record a demo or a bug for a pull request with `start_recording` once the
  screen is set up, and `stop_recording` when the part worth watching is
  over; `close_session` saves one still running. Videos are not masked:
  keep secrets off screen while recording.
- A failed action is an error result that leads with the tool, its target,
  and the code (`tap #n9 failed: LOCATOR_NOT_FOUND: ...`) and still shows
  the screen it re-observed: re-aim from that screen.
- Nothing a session does is recorded as a test or into the replay cache. A
  session is for looking and trying; the test is what you write afterwards.
- A run from the shell and a live session can share the app only if the
  engine's `command` uses `reuseExisting`; otherwise close the session before
  running.
- Parallel agents (subagents) share one server: each opens its own session
  and passes its session id to every `tools`, `call`, and `close_session`.
  A call may leave `session` out only while one session is open. Sessions
  open at once share one config. Sessions on the same app command share its
  process, which stops when the last of them closes. On mobile, two
  sessions on one simulator fight over it: declare one target per device,
  each naming its `device`, and open each session on its own target.
- `TARGET_REQUIRED`: pass `target` to `open_session` or start with `--target`.
  `NO_SESSION`: call `open_session` first, or the session named has ended
  (the message says why). `SESSION_REQUIRED`: several sessions are open;
  pass `session`. `SESSION_OPEN`: every session slot is taken (close one,
  or raise `--max-sessions`). `CONFIG_IN_USE`: open sessions use another
  config; open on theirs, or close them first. `ENGINE_IN_USE`: the
  target's engine comes from a package every session shares; create it in
  the config or a file it imports by path. `UNKNOWN_TOOL`: the name is not
  in this session's catalog; the message lists what is.
