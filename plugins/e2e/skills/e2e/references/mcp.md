# Driving the app over MCP

`e2e mcp` serves a project's live app to a coding agent over MCP (stdio). The
coding agent drives the app the way the testing agent does, writes a test
as it walks the flow, and checks its locators before writing them. Running tests
and reading a failed run stay on the CLI (topics `running` and `debugging`).

## Contents

- Setup
- Tools
- Workflow
- Rules

## Setup

The server ships with the project's `e2e` dependency, separately from the
skills-only plugin. `e2e init` offers to register it for Claude Code and
Cursor. Reuse an existing registration; when adding one, use the project's
config so it starts in the project it drives.

Codex reads `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.e2e]
command = "npx"
args = ["e2e", "mcp"]
```

`codex mcp list`, run in the project, shows the server. Start a new session
after registering it so the tools load. Claude Code can register it with:

```bash
claude mcp add --scope project e2e -- npx e2e mcp
```

Or declare it in the client's project config (`.mcp.json` for Claude Code,
`.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code):

```json
{ "mcpServers": { "e2e": { "command": "npx", "args": ["e2e", "mcp"] } } }
```

Sessions run on the project's config (`e2e.config.ts`, `.mts`, `.js`, or `.mjs`):
in a project without one, `open_session` fails with `CONFIG_NOT_FOUND`, so
set it up first (topic `setup`). No model is needed: without the optional `ai` package, sessions
open and the deterministic tools work.

Flags: `--config <path>` names the default config file, `--target <name>`
fixes the target every session opens on, `--headed` shows the browser or
simulator when the engine supports it in sessions that do not set `headed`
(sessions are headless by default, as in `e2e run`), `--max-sessions <n>`
sets how many sessions may be open at once (default 4, 1 through 16).

## Tools

Four tools, all on the server registered as `e2e`; everything a session can
do is a catalog behind `call`. Clients show them with the server name, such
as `mcp__e2e__open_session` in Claude Code; when another MCP server offers a
tool with the same name, use the `e2e` server's.

| Tool | Does |
| --- | --- |
| `open_session` | Loads the config (`config` names another file; default the nearest `e2e.config.ts`), starts the declared app command if any, boots the engine, opens the app (its URL, or launches a device's pinned app; it installs no build, so a local device needs `app.bundleId`), and returns the session id, the catalog, and the first observation. `target` is required when the config declares several. `headed: true` shows the browser or simulator when the user wants to watch; without it the session follows the server's `--headed`, headless by default. Each session has its own browser or device. |
| `tools` | The catalog: one line per tool with its argument names (`?` marks optional), the first sentence of its description, and `[read-only]` where it changes nothing. `tools {tool}` shows the full description and the JSON Schema of its arguments. |
| `call` | Runs one catalog tool: `call {tool: "tap", args: {target: "n42"}}`. Arguments are checked against the tool's schema first; a wrong one fails with `INVALID_ARGUMENT` naming the field. |
| `close_session` | Saves a recording still running, ends the attempt, disposes the engine, stops the app processes the session started once no other session uses them. |

The catalog, per session:

| Catalog tool | Does |
| --- | --- |
| `observe` | A fresh observation: one node per line as `#id role "name" ...`, plus the current path. On the web engine a link's `href` is its path on the app URL's origin, else origin and path (`mailto:` and `tel:` keep their scheme, `blob:` its inner origin and path); `?…` and `#…` mark a dropped query or fragment, `data:…` and `javascript:…` an inline payload, a trailing `…` a target cut at 256 characters. |
| `tap`, `double_tap`, `long_press`, `right_click`, `hover`, `type`, `press`, `select`, `check`, `scroll`, `scroll_to`, `drag`, `upload`, `navigate`, `back`, `dismiss_keyboard` | The grammar verbs, as the testing agent gets them: `check` takes `checked`, `drag` a `to` node, `upload` project-relative `files`; `dismiss_keyboard` comes with device engines. On an engine that declares `tapModifiers`, `tap`, `double_tap`, and `right_click` take an optional `modifiers` list (`Shift`, `Control`, `Alt`, `Meta`, `ControlOrMeta`) to hold keys for the click. Each reports what changed on screen and, after its lead, the test line that repeats it (`Test line: await screen.getByRole("button", "Save").tap();`) or `No test line:` and why; `observe` shows the whole screen. A verb the engine cannot honor is not listed and fails with `UNSUPPORTED_CAPABILITY`. |
| `type_secret` | Fills a configured secret by name: a credential's password into a password field, a `secrets` entry into any editable input; the plaintext never reaches the agent, and its test line names the credential or secret (`fill(credentials.user(name).password)`, `fill(secrets.get(name))`). Listed when the config declares `credentials` or `secrets` and the engine can fill secrets. |
| `locate` | Tries a semantic locator with exactly one of `role`, `text`, `label`, `placeholder`, `testId` (`name` only with `role`; `exact` optional; anything else is `INVALID_ARGUMENT`) and returns how many nodes match, which, and the `screen.*` call to write. |
| `test_lines` | Every test line the session's actions printed, in order, as a draft test body, starting with `await app.open();` for the session's own opening; an action without a line shows as a `//` comment. A line's locator matched the target alone on the live screen before the action (role and name first, test id last, narrowed to `{ visible: true }`, a container, or `.nth(i)` with a comment when twins share it); a fill names `credentials.user(name)` or `secrets.get(name)`, never a value; a navigation on the app's origin is written as its path. |
| `screenshot` | The masked pixels as an image. |
| `tap_at` | Taps a point (`x`, `y` in the latest screenshot's pixels) where you aim. An engine without a bare-point tap taps the listed control under it by id instead, and fails on a point on nothing listed. Listed when the engine declares `tap` or a bare-point tap. |
| `hover_at` | Hovers a point the same way: the bare point, otherwise a listed control under it by id. Listed when the engine declares `hover` or a bare-point hover. |
| `type_at` | Types `value` into the field at a point: a listed input under it is filled by id; with a keyboard, anything else is tapped to focus it and typed into, at the caret unless `replace` is set. Without a keyboard a point on nothing listed fails. Listed when the engine declares `type` or a keyboard. |
| `press_at` | Sends one `key` (`Enter`, `Escape`, `Tab`) to the control at a point: a listed control gets it by id; with a keyboard, anything else is tapped to focus it and the key goes through the keyboard. Listed when the engine declares `press` or a keyboard. |
| `select_at` | Picks the option whose visible label is `value` in the select-like control at a point; the point must land on a listed select. Listed when the engine declares `select`. |
| `start_recording` | Starts a video of the app (`name` optional, for the file name). Listed when the engine records video. |
| `stop_recording` | Stops it and returns the absolute path of each video file, under `<output>/videos/<session>/` (`.e2e` by default), or the URL of a provider's own recording. |
| Project tools | Every `defineTool` in the agent's `tools` that applies to the target's platform, under its own name; an engine pack such as `mobileTools` adds `open_app`, `swipe`, `alert`. |

Project tools use their `toModelOutput` renderer for strings as well as
structured results. Its `error-text` and `error-json` outputs set the MCP
result's `isError: true`; treat them as failed calls.

Once a secret is filled in the session, `screenshot` and the point tools
(`tap_at`, `hover_at`, `type_at`, `press_at`, `select_at`) answer with a
`PIXEL_TAINTED` line for the rest of it; act on listed nodes by id (topic
`writing-tests`). Before the session's first `screenshot`, a point tool only
says to take one.

Resources: `e2e://guide` and `e2e://guide/<topic>` hold this skill.

## Workflow

1. Before `open_session`, create `tests/<feature>.e2e.ts` (topic
   `writing-tests`) with its imports, the `test(...)`, and the call that
   opens the screen it covers, such as `app.open('/settings/members')`.
   Then `open_session`, which opens the app, and go to that screen: on the
   web, `call {tool: "navigate", args: {url: "<the path app.open names>"}}`;
   on a device, the shortest path from the launch screen. Actions that only
   got you there, such as a sign-in the test's saved session replaces, stay
   out of the test when its opening reaches that screen directly; otherwise
   they are its first steps. Node ids are valid only for the newest
   observation; an action reports what changed, so `observe` again before
   using new ids.
2. Walk the flow one screen at a time, and write each screen's steps into
   the file before you leave it. Do not walk the whole flow first and write
   the test from memory afterwards. Each step is one of two kinds:
   - An `agent.act` goal, the default for a path that varies: write the goal
     with the words on screen and its values in `params`, then walk its
     path in the session. Those actions stay out of the test, and so do the
     test lines they print.
   - A `screen` line, for an exact value or interaction: a sign-in form in a
     setup test, a field that must receive one specific string, an
     interaction that is the point of the test. Act on the control by node
     id, then copy the `Test line:` the action printed into the file. Its
     locator matched that control alone on the live screen. When the action
     prints `No test line:` instead, the reason says why; for a control no
     locator found alone, try one with `locate`.

   With several `screen` steps on one screen, take their actions, then add
   the lines they printed in one edit.
3. When the outcome shows, add its check before the next step: an `expect`
   on a locator you tried with `call {tool: "locate", args: {...}}`, or an
   `agent.assert`. One match: use the printed `screen.getByRole(...)` call.
   Zero or several: adjust before writing it; the same failure would hit
   the test as `LOCATOR_NOT_FOUND` or `LOCATOR_AMBIGUOUS`. A role query's
   `name` matches the accessible name only, while `observe` shows a
   `status`, `alert`, or `listitem` by its text: `status "Saved."` on an
   unlabelled status is its text, so match it with
   `getByRole('status').filter({ hasText: 'Saved.' })` or `getByText`.

   When the walk ends, the test is written and every locator you copied
   from a `Test line:` or a `locate` result has matched once; the first run
   checks the rest, such as a `.filter()` you wrote yourself. If you missed
   a line, `test_lines` returns every line printed so far, in order, the act
   goals' paths included. One walk, in order:

   ```text
   write   tests/members.e2e.ts: imports, test(...), app.open('/settings/members')
   call    open_session, then navigate {url: "/settings/members"}   its line is the app.open already written
   edit    + await agent.act('invite {email} as an editor', { params: { email: 'ada@example.test' } });
   call    tap, type, select, tap                   the goal's path; its test lines stay out
   call    locate {role: "status"}                  1 node matches, text "Invite sent"
   edit    + await expect(screen.getByRole('status')).toContainText('Invite sent');
   call    type {target: "n40", value: "ada"}       prints the test line below
           Test line: await screen.getByRole("searchbox", "Search members").fill("ada");
   edit    + that line, as printed
   call    locate {role: "listitem"}                1 node matches
   edit    + await expect(screen.getByRole('listitem')).toHaveCount(1);
   ```
4. Run only that test from the shell:
   `npx e2e run tests/<feature>.e2e.ts:<line>` (SKILL.md, "Rerunning a test
   while you fix it"). On a failure, fix from the terminal's failure block
   and the trace page (topic `debugging`), then rerun it the same way. To see a screen the evidence leaves out, go
   straight to it instead of walking the flow again from the start: on the
   web, `navigate` to its path; on a device, the shortest path from the
   launch screen. Then `observe` and `locate`.
5. Leave the session open through those runs, on the screen under test,
   wherever Rules lets a run go beside it, so step 4's live look needs no
   new session. `observe` does not reload: `navigate` even to the screen
   the session is on when the run or a fix may have changed what it shows.
   A live look's actions print test lines too: copy a fixed line from its
   action, since `test_lines` also lists the looks after the first walk.
   `close_session` once the test passes; an idle session closes on its own
   after 30 minutes and never outlives 4 hours. When the client exits, every
   session closes and the app commands stop. To look at another project or
   config, `open_session {config: "path/to/e2e.config.ts"}`; no restart
   needed.

## Rules

- Record a demo or a bug for a pull request with `start_recording` once the
  screen is set up, and `stop_recording` when the part worth watching is
  over; `close_session` saves one still running. Videos are not masked:
  keep secrets off screen while recording.
- A failed action is an error result that leads with the tool, its target,
  and the code (`tap #n9 failed: LOCATOR_NOT_FOUND: ...`) and still shows
  the screen it re-observed: re-aim from that screen.
- Nothing a session does is recorded as a test or into the replay cache. A
  session is for looking and trying; the test is the file you write as you
  walk.
- On the web, a session can stay open while `e2e run` runs, unless the two
  collide over the app. Read the target's `app`:
  - No `command` (the app runs elsewhere): both use that app.
  - A `url` on port `0`: the session and each run start their own copy of
    the app. A dev server that allows one copy per directory, such as
    `next dev` in Next.js 16, fails the run with `APP_UNREACHABLE`; close
    the session before each run there.
  - A `command` on a fixed port with `reuseExisting: true`: a run uses the
    app the session started, and its data. Whichever started the app stops
    it: if the session closes during a run (`close_session`, 30 idle minutes
    or the 4-hour limit, since a run is not session activity), the app stops
    under the run. Its next navigation fails with `APP_UNREACHABLE`; a step
    already on the page fails with whatever the dead server breaks. Before a
    long run, `observe` once to reset the idle clock. With `CI` set, as in
    many agent sandboxes, `reuseExisting` is ignored: prefix the run with
    `CI=` to unset it, which also drops the other CI defaults (topic
    `running`), or close the session before each run.
  - A `command` on a fixed port without it: a run beside the session fails
    with `APP_ALREADY_RUNNING`. Offer the user `reuseExisting: true` (CI
    ignores it); never add it unasked. Until then, close the session before
    each run.
- On mobile, close the session before each run: a session and a run on one
  device fight over it. It can stay open only on a target whose `device` no
  run uses, with each run passing `--target` for another; an `app.command`
  both start (Metro) follows the web rules above. Ask before adding a
  target to the user's config (topic `setup`).
- Parallel agents (subagents) share one server: each opens its own session
  and passes its session id to every `tools`, `call`, and `close_session`.
  A call may leave `session` out only while one session is open. Sessions
  open at once share one config. Sessions on the same app command share its
  process, which stops when the last of them closes. On mobile, two sessions
  on one simulator fight over it: one target per device (topic `setup`), each
  session on its own target.
- `TARGET_REQUIRED`: pass `target` to `open_session` or start with `--target`.
  `UNKNOWN_TARGET`: no target of that name; the message lists the declared
  ones. `NO_SESSION`: call `open_session` first, or the session named has
  ended (the message says why). `SESSION_REQUIRED`: several sessions are open;
  pass `session`. `SESSION_OPEN`: every session slot is taken (close one, or
  raise `--max-sessions`). `CONFIG_IN_USE`: open sessions use another config;
  open on theirs, or close them first. `ENGINE_IN_USE`: the target's engine
  comes from a package every session shares; create it in the config or a
  file it imports by path. `UNKNOWN_TOOL`: the name is not in this session's
  catalog; the message lists what is.
