# e2e

## 0.14.0

### Minor Changes

- [#280](https://github.com/tester-army/e2e/pull/280) [`f03006d`](https://github.com/tester-army/e2e/commit/f03006d47f1627d35d4777245bc24df83ff0db86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Secrets are no longer passwords only. A new `secrets` config block declares any value the model must never see (an API key, a token, anything from the environment), as a string, a provider function, or `{ value, allowedOrigins }`, overridable per run with `E2E_SECRET_<NAME>`. `secrets.get(name)` from `@e2edev/e2e` returns the same opaque `Secret` handle a credential's password is, accepted by `locator.fill`, `agent.act` params, and the `type_secret` tool; the runner fills it, masks it in every observation, and redacts it from logs, traces, and the report. A password still fills only a password field; a generic secret fills any editable input. An unconfigured name fails with the new `SECRET_UNAVAILABLE` code. `Secret.purpose` narrows to `'password' | 'generic-secret'`; `'one-time-code'` was never produced. A deterministic `locator.fill` of a secret now checks the current origin against the target's and the secret's `allowedOrigins` before resolving the value, as `type_secret` always has; `allowedOrigins` entries and the keys of a `secrets` object are validated at config load.

- [#284](https://github.com/tester-army/e2e/pull/284) [`8811ba7`](https://github.com/tester-army/e2e/commit/8811ba7de97b239f8d1a32fb0785ff00d7f0011e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A built-in `markdown` reporter writes the run as one markdown page,
  `.e2e/summary.md` beside `report.json`, laid out for a pull request: a
  headline with the counts and, when the agent ran, what the run spent (agent
  steps, cache replays, model calls, tokens, cost); run-level errors; one block
  per test that failed or was flaky with its error, the step it went wrong at,
  the agent's own explanation of what it saw, the attempt's step timeline, and
  the paths of its evidence from the project root; a table with one row per
  test file; and every test folded away, grouped by file. An `e2e explore` run
  renders its record instead: the goal and steps, every finding with what was
  expected, what the screen showed, the actions that reach it, and its
  screenshot, then the assessment. It is the text a coding agent pastes into a
  pull request or a handoff instead of retelling the result.
  `renderMarkdownReport(report, { artifactsUrl, artifactsDir, sourceUrl })` is
  exported from the main entrypoint for a reporter that posts the page
  elsewhere. `@e2edev/github` posts this page as the pull request comment in
  place of its one table of tests that did not pass; its `renderComment`,
  `CommentOptions`, `MAX_MARKER_CHARS`, and `MAX_URL_CHARS` exports are gone
  (nothing consumed them), and the package now needs `@e2edev/e2e` 0.13 or
  later. `e2e init` ignores `.e2e/summary.md`.

- [#283](https://github.com/tester-army/e2e/pull/283) [`4480e8b`](https://github.com/tester-army/e2e/commit/4480e8b0e589ef06c116c59eddbef82e1bb65dfb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `OperationContext.origin` tells an engine who is acting: `'test'` for a test's own deterministic step, `'agent'` for the agent. A step verifies its outcome with `expect`, so an engine may act as soon as the target holds still; the agent reads the screen right after acting, so an engine may wait for the transition to end first. The locator engine marks its calls `test`, the agent loop marks its calls `agent`; an absent origin is treated as the agent's.

### Patch Changes

- [#282](https://github.com/tester-army/e2e/pull/282) [`ff33218`](https://github.com/tester-army/e2e/commit/ff33218345d96098d6c2b665b23ece67e46b8eec) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The bundled skill and the `init` scaffold now describe e2e as agentic testing first. The skill's workflow tells a coding agent to drive a flow with `agent.act` and pin each outcome with `expect`, to use `screen` for exact values, to commit the trace cache so CI replays passing steps, and to specialise the agent for the app (goal wording, `context`, `system`, tools, model options) before rewriting a goal as clicks. The CI guidance runs agent steps in the same job as everything else instead of a separate config on a schedule. The scaffold's config and example test carry one comment each instead of five, and say "natural language" where they said "plain language".

- [#278](https://github.com/tester-army/e2e/pull/278) [`7a45609`](https://github.com/tester-army/e2e/commit/7a456094a8d8ebb930c073f2cfe5ffa83315bd77) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` adds `agent-device` to `devDependencies` next to `@e2edev/agent-device`, which now peers on it instead of installing it. The range pins the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `agent-device` keeps its version untouched.

- [#286](https://github.com/tester-army/e2e/pull/286) [`fce4aaf`](https://github.com/tester-army/e2e/commit/fce4aafeea8e6154e42ea0f2e6574b0b13285401) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replayed trace actions carry the test origin. A replay executes recorded actions with no model reading the screen after them, only its own relocation, which polls; so an engine treats them as deterministic steps. On the device engine that removes the settle wait from every replayed action.

## 0.13.0

### Minor Changes

- [#258](https://github.com/tester-army/e2e/pull/258) [`c553b61`](https://github.com/tester-army/e2e/commit/c553b614def4da798be5bfa3f7f04591dc253b69) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The act loop sees pixels. Two tools join the built-in agent's grammar while no
  secret has been filled in the attempt: `screenshot()` attaches a masked
  screenshot of the viewport to its result, and `tap_at({ x, y })` taps a point
  given in that screenshot's pixel coordinates. The act model receives the image
  itself, so nothing is lost in a description and no second model call is spent
  on a localizer. Once a screenshot was sent the step is in pixel mode: every
  action result carries a fresh screenshot, and older screenshots are elided
  from the conversation in batches, keeping the newest two, and each is
  resampled to a long side of at most 768 pixels, so a long flow on a canvas
  carries a bounded number of images at a third of the full capture's cost.
  While the step shows pixels, the wait after an action watches the pixels too,
  so a tap that redraws a canvas is read as soon as the redraw lands. A screen that lists nothing to act
  on by id opens with a screenshot already attached. `tap_at` is routed onto the
  tree: a listed control under the point is tapped by id through the ordinary
  `tap` path, policy and trace descriptor included; a point on nothing listed is
  tapped as a bare point through the engine's new `tapAt` member. The trace
  cache replays a bare point the way a coordinate-driven tool does, at the same
  point on a viewport of the recorded size or at the same place inside the
  re-found node that contained it, and hands the step to the model when the
  viewport changed (`viewport-changed`) or the node is gone; the recorded end
  state still gates a replay passing on its own. The executor socket gains `actions.tapAt(point)` with the same
  routing and `pixelsTainted`; the engine contract gains an optional
  `tapAt(point, context)` with the `pointer` capability and the `tapAt` grammar
  verb, and pins `SemanticNode.rect` to the top-level viewport's CSS pixels for
  nodes inside nested documents too. `agent.visionModel` is gone: the act model reads
  screenshots itself, so it is multimodal by requirement, and the judgments
  send their pixels to the same `model`.
  Steps that sent pixels record `visionInput` and `metrics.pixelBytes`.

- [#273](https://github.com/tester-army/e2e/pull/273) [`f53e8e2`](https://github.com/tester-army/e2e/commit/f53e8e2246d07f2c7f72bf77202f216a0c44b82d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `url` on a literal loopback address declared with port 0 (`http://127.0.0.1:0`, `http://[::1]:0`) asks the run for a free TCP port. The runner picks one when the config loads, before anything spawns, and substitutes it in the base URL, the default `allowedOrigins` entry (and an explicit one spelled with the same host and `:0`), the default `readyUrl`, and the report's target record; worker processes receive the same assignment, as does a session opened by `e2e mcp`. Port 0 on any other host is `INVALID_APP_URL`, `localhost` included: a name may resolve to another address than the one the command binds, and a port free on one is not free on the other.
  
  `{port}` in the app command's `args` and `env`, in `readyUrl`, and in each service's `args`, `env`, `readyUrl`, and `teardown` expands to the port the app is served on, allocated or fixed; the command must take the port through it. On a target without a `url` the token is `INVALID_CONFIG` naming the field. Services keep the ports their config gives them. The port is free when chosen and handed to the command a moment later; another process binding it in between fails the start with `APP_UNREACHABLE`, which a rerun resolves.
  
  The default cache and session identity derives from the declared URL with `:0`, so trace cache entries survive the port changing per run. Tests read the resolved URL from the new `app.baseUrl`, `undefined` on a surface whose engine declares no `url`.

- [#258](https://github.com/tester-army/e2e/pull/258) [`c553b61`](https://github.com/tester-army/e2e/commit/c553b614def4da798be5bfa3f7f04591dc253b69) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `'fallback'` vision mode is gone. It was documented as behaving like
  `false` for every judgment, because a judgment always answers from the tree and
  has no miss to escalate on, so it never did anything. `VisionMode` is now
  `boolean | 'only'`; a config or call that still passes `'fallback'` fails with
  `INVALID_CONFIG` or `INVALID_ARGUMENT` naming the accepted values. Replace it
  with `false` (the tree) or, where pixels were wanted, `true` or `'only'`.

- [#268](https://github.com/tester-army/e2e/pull/268) [`cadebfa`](https://github.com/tester-army/e2e/commit/cadebfaef4d24f653b1715ea2c21062a78fef3f8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect.poll(read, options?)` re-reads a value until a value matcher passes,
  the asynchronous form of `expect(value)`. Every value matcher is there under
  the same name, returning a promise, with `.not` to flip the check. Options:
  `timeout` (the config `assertionTimeout`, 5000 ms; capped by the attempt's
  own deadline, and 5000 ms in a standalone script), `interval` (100 ms), and
  `message`, an extra line in the timeout error. The poll runs on the
  attempt's budget and stops at once when the attempt is cancelled or times
  out. A `read` that throws is one failing sample and polling continues; one
  that hangs is cut at the deadline. The timeout is `ASSERTION_FAILED` with the
  last sample in its message; a non-finite `timeout` or `interval` is
  `INVALID_CONFIG` before the first read. It is not recorded as a report step.
  
  `expect(value).toMatch(regexp)` now resets a global or sticky regexp before
  each test, so repeated checks of the same value agree.
  
  ```ts
  await expect
    .poll(() => getTest(workspace).then((row) => row?.title), { timeout: 15_000 })
    .toBe('AI checkout regression');
  ```

- [#276](https://github.com/tester-army/e2e/pull/276) [`1bf533f`](https://github.com/tester-army/e2e/commit/1bf533f6648894f145ef98d919727f22b755bfa7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e explore` reads as an exploration, not as a test. The terminal shows each step by its title as it finishes, with its duration, actions, and findings, and each finding the moment the agent reports it. The run ends with a `Findings` section, issues first and the most severe first, each with where it was seen, what was expected against what the screen showed, the steps that reach it, and its screenshot; then the assessment and `Findings` and `Steps` summary rows. Severity reads as a word (`critical` to `trivial`). The exploration's progress travels as a new `explore` run event, so custom reporters see it too; the summary rows the explore reporter used to add are gone. The planner titles steps as short headings and closes with a verdict, what was not reached, and what is worth scripting.

- [#271](https://github.com/tester-army/e2e/pull/271) [`694c5fb`](https://github.com/tester-army/e2e/commit/694c5fb9eacf1aa1aa0cbaf70b61bd428331d23b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `test.extend(fixtures)` defines your own fixtures with setup and teardown, in
  Playwright's shape: everything before `await use(value)` runs before each
  attempt's hooks and body, `value` is what the test receives, and everything
  after runs once they are done, whether or not the body passed (a body that
  timed out is abandoned first, as with `afterEach`). It returns a new `test`;
  chains compose, and a definition in a chained `extend` reads the earlier ones. A
  core name, a name an earlier `extend` defined, or a non-function is a
  `COLLECTION_ERROR` at import; a name the target's engine contributes, a
  definition that never calls `use()`, or one that calls it twice fails the
  attempt with `TEST_SETUP_FAILED`. The zero-argument `test.extend<Extra>()`
  keeps typing an engine's contributed fixtures without defining anything.

### Patch Changes

- [#266](https://github.com/tester-army/e2e/pull/266) [`fcf4fe6`](https://github.com/tester-army/e2e/commit/fcf4fe6ff7f4ba1b0d6a61af53ce0bde953ad26c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Reject `app.screenshot()` with `POLICY_DENIED` after a secret fill. The runner now stops before engine capture or artifact registration so secrets echoed outside secure fields cannot enter explicit screenshot artifacts.

- [#275](https://github.com/tester-army/e2e/pull/275) [`07cae87`](https://github.com/tester-army/e2e/commit/07cae8787ca1d530ac4f85729a9d7793bf3100fa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI is documented and registered as `npx e2e`. The `--no-install` flag is gone from the help text, the `e2e init` hints, the MCP server prompt, the `.mcp.json` and `.cursor/mcp.json` entries `init` writes, the skill, and the docs. npx runs the locally installed bin first, so the flag added nothing once the package was a dependency, and the unscoped `e2e` name on npm is the team's own placeholder.

- [#272](https://github.com/tester-army/e2e/pull/272) [`dfc4feb`](https://github.com/tester-army/e2e/commit/dfc4febe46da37420643b51bb969f423800d22fe) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` adds `playwright` to `devDependencies` next to `@e2edev/playwright`, which now peers on it instead of installing it. The range is the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `playwright` keeps its version untouched.

- [#263](https://github.com/tester-army/e2e/pull/263) [`c76f152`](https://github.com/tester-army/e2e/commit/c76f152ef5668b1c2cc50b6e756af8f4d273a361) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The notice `e2e init` prints when it adds `.e2e/cache/` to `.gitignore` now
  links to the caching guide (`/cache#commit-your-traces`) instead of an anchor
  inside the config reference.

- [#266](https://github.com/tester-army/e2e/pull/266) [`fcf4fe6`](https://github.com/tester-army/e2e/commit/fcf4fe6ff7f4ba1b0d6a61af53ce0bde953ad26c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` now uses GPT-5.6 Luna in generated model configurations instead of GPT-5.4 mini.

- [#267](https://github.com/tester-army/e2e/pull/267) [`454e9e2`](https://github.com/tester-army/e2e/commit/454e9e24f4f4e766010236925bec62d129dc788f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run` and `e2e list` match a positional that names no existing path by
  name: `saved-tests.e2e.ts`, `regression/saved-tests.e2e.ts`, and `saved-tests`
  all select `tests/regression/saved-tests.e2e.ts`. Before, such a positional had
  to be the whole root-relative path or the run ended in `NO_TESTS`. The match is
  exact and case-sensitive, ends at a path-segment boundary, and still never
  selects a file the config globs did not discover.
  
  A positional that starts with `-` and names no existing file is now a usage
  error with exit code 2 instead of a file that matches nothing. `pnpm test:e2e
  -- --headed` reaches the CLI as `run -- --headed`, so `--headed` used to be
  swallowed and the run went on headless; the message now names the direct
  command for the detected package manager with the whole forwarded tail
  (`pnpm exec e2e run --tag smoke`). A file that really starts with a dash still
  selects as before.

- [#270](https://github.com/tester-army/e2e/pull/270) [`38b3f1e`](https://github.com/tester-army/e2e/commit/38b3f1e7546f379201cf043166c9da3c727c9b39) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `command` or service that fails to start now says what it was doing. When
  `log` is set, the `APP_UNREACHABLE` message ends with the last 20 lines
  appended to the log since the process started (terminal controls stripped,
  each `command.env` value replaced by its `<secret:NAME>` marker, at most 4 KB), or `no output in <log>` when
  nothing was appended; without `log` it says to set one. A wait that passes
  half of `startupTimeout` (once that half is at least 5 s) prints one notice,
  `service "compose" still starting after 90s: waiting for it to exit; log:
  .e2e/logs/services.log`, so a stalled `docker compose up --wait` is visible
  while it stalls and diagnosable from the report alone ([#158](https://github.com/tester-army/e2e/issues/158)).

- [#277](https://github.com/tester-army/e2e/pull/277) [`3de7471`](https://github.com/tester-army/e2e/commit/3de7471f774bd13c4ead65991e56d7c7300ba653) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A test declared through a project helper (`dashboardTest(...)` in
  `support/test.ts` wrapping `test()`) reports the helper call in the test file
  as its source, so a GitHub comment or JSON report links the test, not the
  helper. Before, every such test pointed at the same line inside the helper.
  When no frame of the test file is on the stack (the file imports a module that
  declares the tests), the declaring module is reported as before. The runner's
  own frames and frames under `node_modules` are never a test's source; the
  0.10.0 build reported a source-mapped runner frame under `node_modules/.pnpm`
  for every test.

## 0.12.0

### Minor Changes

- [#265](https://github.com/tester-army/e2e/pull/265) [`00ce413`](https://github.com/tester-army/e2e/commit/00ce41396d1f0789032b7a8cd3078d03b34092ec) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `list` reporter's summary gains a `Cache` row under `AI` with the trace
  cache's part in the run, counted by agent step: `9 replayed · 2 handed off ·
  4 missed`. A replayed step ran whole from its recorded actions with no model
  turn, a handed-off step replayed a prefix before the model took over, and a
  missed step had no usable entry. Zero counts are left out, so a cold cache
  reads `Cache  20 missed`; a run with the cache off has no row.

- [#181](https://github.com/tester-army/e2e/pull/181) [`afde198`](https://github.com/tester-army/e2e/commit/afde1981c569e796dafd3eeed303c1eac8a6833c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp` serves a project's live app to a coding agent over the Model
  Context Protocol on stdio, through four fixed tools in the style of
  executor.sh: `open_session` loads a config (the nearest one, or the path
  the call names), starts the declared app command, boots the engine, and
  returns the session's catalog and first observation; `call` runs any
  catalog tool by name (`observe`, `tap`, `type`, `press`, `select`,
  `scroll`, `navigate`, `type_secret`, `locate` to try a semantic locator
  before writing it, a masked `screenshot`, and the project's `defineTool`
  values), validating its arguments against the tool's own schema; `tools`
  describes the catalog; `close_session` ends it. The client's tool list
  never changes, so one server covers every project and config the agent
  opens without a restart. Sessions enforce the same origin, secret, and
  pixel policy as tests, close on idle, and never outlive the client. The
  agent skill is served as resources. `e2e init` registers the server in
  `.mcp.json` and `.cursor/mcp.json`, `e2e guide mcp` prints the new skill
  topic, and `createAgent` now returns its `tools` so a host can serve them.

- [#262](https://github.com/tester-army/e2e/pull/262) [`8287bf9`](https://github.com/tester-army/e2e/commit/8287bf930b2e37311d215900eb91d192edefc663) Thanks [@okwasniewski](https://github.com/okwasniewski)! - One flow, several personas. The `agent` option on a test or describe block accepts a list, and the test then runs once per agent named, as one result each, in one run. `--agent` takes several names too, comma-separated or repeated: every unpinned test runs once per name, and a pinned list narrows to the names the flag also gives (a pin the flag misses stands whole, so `--agent thorough` still benchmarks a model across everything that has no opinion while every persona stays itself). A serial group runs as one unit per agent and its members share one pin; a setup test runs once per target and pins at most one agent.
  
  Every result and serial group in the report records the `agent` it ran as, and the result id now digests `{ testId, targetId, agent }`, so the id of every result changes once. Reporters tell variants apart: the list reporter appends `[admin]` to a title that ran as an agent other than `default`, JUnit case names carry the same tag, and artifacts of one attempt live under `<target>/<test id>/<agent>/attempt-<n>`. The `run-started` event carries `agents` (a list) in place of `agent`, and `test-started` and `step` events carry the pair's `agent`.

### Patch Changes

- [#257](https://github.com/tester-army/e2e/pull/257) [`6526dc6`](https://github.com/tester-army/e2e/commit/6526dc6daa0d3c646c650800560447674af93ae0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Runtime dependencies move to their current releases: `zod` 4.6.1 in both
  packages, `@clack/prompts` 1.8.0 in `@e2edev/e2e`, and `agent-device` 0.21.0
  in `@e2edev/agent-device`. No behavior changes on our side.

- [#264](https://github.com/tester-army/e2e/pull/264) [`3e66c42`](https://github.com/tester-army/e2e/commit/3e66c4280b18985266dabf892d5a2c5ebd3e23b7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e explore --help` and the `explore` skill topic no longer say the model can
  come from `E2E_MODEL`. Nothing reads that variable: the model is the selected
  agent's, constructed in `e2e.config.ts`, as for `e2e run`.

- [#259](https://github.com/tester-army/e2e/pull/259) [`07c5334`](https://github.com/tester-army/e2e/commit/07c5334d08167941b49aadb46945e54cb84cfd66) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.act` runs on models that refuse a forced tool choice. The loop asks
  every model for a tool call per turn and names `complete_step` on the final
  ones; a model that answers HTTP 400 to that request shape (Anthropic's Claude
  Fable 5.1 does) is asked again with `auto` and a tool-calls-only rule in its
  instructions, on the same turn budget, and later steps on that model start in
  that mode. A turn that comes back as prose without a tool call no longer ends
  the step: the reply stays in the history and the model is told to act, until
  the turn budget runs out as before.

- [#256](https://github.com/tester-army/e2e/pull/256) [`4cc86dc`](https://github.com/tester-army/e2e/commit/4cc86dcfafab5ef9ab12e37aac18d0d3c3d4f3de) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` lists the engines as Web (Playwright), Mobile (iOS/Android) with agent-device, and None last. Its closing `next:` line and the skipped-skill hint run the CLI through the project's package manager (`npm run test:e2e`, `pnpm exec e2e guide`) instead of `npx --no-install`. The CLI, README, and skill link to the docs at https://e2e.mintlify.app; the Vercel-hosted address returns 404.

## 0.11.0

### Minor Changes

- [#243](https://github.com/tester-army/e2e/pull/243) [`b8a7824`](https://github.com/tester-army/e2e/commit/b8a7824e9bbe51465d90d88ea063a3742246305c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e explore [goal]` runs the agent against the app with a goal instead of a
  test file. It plans one exploration step at a time from the goal, the steps
  and findings so far, and the current screen; runs each charter as an
  `agent.act()` step of the built-in agent, with the project's tools plus a
  `report_finding` tool that records a defect with its severity and reproduction
  steps, the current path when the engine reports one, and a redacted evidence
  screenshot when the engine grants pixels; and ends with a closing assessment when the goal
  is covered, at the step limit (`--max-steps`, 1 to 12, default 8), at the wall
  clock (`--timeout` in milliseconds, 180000 to 900000, default 600000), or
  after three failed or blocked steps in a row that reported nothing. A failed
  step is recorded and the run goes on; a step that hits its budget ended at its
  limit and is not a failure; findings of kind `issue` fail the run (exit 1),
  warnings do not; a run that explored nothing and found nothing is blocked,
  never a pass. The run is an ordinary run of one in-memory test under the
  virtual file `explore`, so reporters, `.e2e/report.json`, artifacts,
  `--video`, `--ai-trace`, `--debug`, and Ctrl-C behave as for `e2e run`; the
  report gains `run.explore` with the goal, budgets, steps, findings, and
  assessment, and the `list` reporter prints the findings under the summary. The
  exploration runs as `agents.default`, or as the agent `--agent` names, with the
  explorer built from that agent, so the model is that agent's or `E2E_MODEL`. Configured `credentials` travel with
  every charter as step secrets, so the explorer signs in with `type_secret` by
  account name and the password never reaches the model. An agent built with
  `createAgent({ tools, system })` lends its vocabulary to the explorer:
  `createAgent` now returns a `DefaultAgent` whose `options` are readable. A
  finding's evidence screenshot is an ordinary `screenshot` artifact of the
  attempt, attached to the step that reported it and referenced by `artifactId`;
  project tools can keep evidence the same way through the new
  `attachScreenshot(pixels, label)` on the tool context and on
  `StepExecutorContext`. `e2e guide explore` prints the new skill topic.

- [#255](https://github.com/tester-army/e2e/pull/255) [`2d0c693`](https://github.com/tester-army/e2e/commit/2d0c6931c4336de1a9479d7bf4c0afa0baa18277) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The model is always an AI SDK instance the config constructs, and the runner
  has no gateway of its own. `provider/model-id` strings and the `ModelConfig`
  object are gone, along with `E2E_MODEL`, `E2E_VISION_MODEL`,
  `E2E_MODEL_API_KEY`, `E2E_MODEL_ENDPOINT`, and the `AI_GATEWAY_API_KEY`
  fallback: every one of them quietly routed through the Vercel AI Gateway,
  which the runner is not supposed to know about. Write the constructor
  instead: `gateway('openai/gpt-5.4-mini')` from `ai` for the Vercel AI Gateway
  (reads `AI_GATEWAY_API_KEY`), `openrouter('openai/gpt-5.4-mini')` from
  `@openrouter/ai-sdk-provider` (reads `OPENROUTER_API_KEY`),
  `createOpenAICompatible({ name, baseURL }).chatModel('llama3.2')` from
  `@ai-sdk/openai-compatible` for any OpenAI-compatible endpoint, or a provider's
  own package. A string in `agent.model`, `agent.visionModel`, or
  `createAgent({ model })` is `INVALID_CONFIG` naming the constructor to write.
  
  `e2e init` asks which gateway agent steps use (Vercel AI Gateway, OpenRouter,
  an OpenAI-compatible endpoint with its URL, or none) instead of a yes/no on AI,
  adds that provider package, and writes the import and the constructor into
  `e2e.config.ts`; `--yes` picks the Vercel AI Gateway and still writes it out.
  Credentials are the provider's business: a missing key is the provider's own
  error on the first agent step, and a rejected one is reported as such. Reports
  record the instance's provider and model id, OpenRouter's per-request cost is
  read from its usage accounting, and telemetry gains `model_gateway`, the AI
  SDK provider that served the first model-backed step. A new docs page, Models
  and credentials, covers which package constructs which model and where each
  reads its key.

- [#253](https://github.com/tester-army/e2e/pull/253) [`31db985`](https://github.com/tester-army/e2e/commit/31db98562ad004205e9862e944f6218bc504964f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The agent loop addresses the provider's prompt cache, keeps its history
  cacheable, and recovers once from a request the model cannot fit.
  
  - Every model call carries what the provider needs to serve the repeated
    prefix from its cache: on Anthropic models a cache breakpoint on the system
    prompt (covering the tool definitions) and one on the newest message, moved
    forward each turn; on OpenAI models a prompt-cache key derived from the
    system prompt, so every call of a run routes to the same cache. A caller's
    own `providerOptions` win on conflict. Other providers see no change.
  - Superseded full screens are no longer elided one turn at a time. They stay
    verbatim until they together outgrow 32 KB, then go in one batch, so the
    request prefix stays byte-identical across the turns of a step and the
    cache can serve it. A two-turn step whose screens fit the budget never
    elides.
  - The report records the cache split: `model.cacheReadTokens` and
    `model.cacheWriteTokens` per step, `usage.modelCachedTokens` per run, the
    `list` reporter's usage line shows the cached share (`12.4k tokens · 38%
    cached`), `--debug` adds a `cached` column to the agent step table, and
    the run telemetry event gains `model_cached_tokens`.
  - A request the provider refuses as larger than the model's context window
    is recognized (the error catalog covers twenty providers and the HTTP 413
    some answer with) and retried once with the step's history shrunk:
    superseded screens elided, any text longer than 16 KB cut to its head with
    a notice. The retry continues the same turn budget and is skipped when
    shrinking would change nothing. A second refusal, a refusal nothing could
    shrink, or one on a judgment call, is the new `CONTEXT_OVERFLOW` code
    (blocked: automation) instead of `MODEL_PROVIDER_FAILED`.
  - A text result from a project tool is bounded to 400 lines or 16 KB,
    whichever comes first, notice included. The cut lands on a line boundary,
    except for a single line that alone exceeds the budget, which keeps its
    head; the notice names how much was left out. Structured results pass
    through unchanged.

### Patch Changes

- [#254](https://github.com/tester-army/e2e/pull/254) [`95cc950`](https://github.com/tester-army/e2e/commit/95cc950dd2389d415cd0c5667c42eca04053e18d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A test's `source` in the report names the `test()` call in the test file again. Under tsx, source maps relocate the runner's own stack frames from `dist/` to `src/`, which the frame filter did not recognize, so every test was attributed to the runner's `registry.ts`: relative to the project when `node_modules` lives inside it, otherwise the file's first line. The GitHub reporter's source links and the JUnit locations follow.

## 0.10.0

### Minor Changes

- [#249](https://github.com/tester-army/e2e/pull/249) [`658b9c2`](https://github.com/tester-army/e2e/commit/658b9c22cc46abdeca54a373fd164616c2b70ff2) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A test or a describe block pins the configured agent it runs with through the
  `agent` option (`{ agent: 'buyer' }`), and `act`, `assert`, `waitFor`, and
  `extract` take `{ agent: 'name' }` to run one call with another. Innermost
  wins: a call's agent beats the test's, which beats its groups, which beat the
  run; `e2e run --agent <name>` re-points what unpinned tests use and never
  overrides a pin. A pin naming nothing in `agents` is a `COLLECTION_ERROR`
  before any process starts, with the configured names; an unknown name on a
  call is `INVALID_ARGUMENT` before the step opens. Every agent step records the
  agent it ran with as `step.agent` in report-1. Each worker checks an agent's
  model once, on its first use, and shares the adapter with every agent that
  names the same model.

- [#244](https://github.com/tester-army/e2e/pull/244) [`c72b05e`](https://github.com/tester-army/e2e/commit/c72b05e57fae0e4925d9ff6d4ad896f2df64cb35) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Agents are named. `agents` is a record of the shapes `agent` used to take: an
  options block, or the agent itself from `createAgent(...)` or any
  `StepExecutor`. `default` is the agent tests run with and exists even when the
  config names none (the built-in agent with `E2E_MODEL`); other names are other
  brains for the same suite, and `e2e run --agent <name>` runs with one of them.
  An unknown name is `INVALID_CONFIG` before anything starts, naming the
  configured agents; every agent diagnostic names its entry (`agents.ux.model`);
  the run-started event and the `list` reporter's run banner carry the agent's
  name when it is not `default`. Breaking: the `agent` key is removed. Write
  `agents: { default: <what agent held> }`; the old key is rejected with that
  replacement in the message. `e2e init` scaffolds the new shape.

### Patch Changes

- [#250](https://github.com/tester-army/e2e/pull/250) [`d4a1953`](https://github.com/tester-army/e2e/commit/d4a1953a85df1e88d83de9f3cc1c3f18705296f4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run` loads `.ts` config, tests, and helpers as ES modules whatever the nearest `package.json` says. A Next.js app, or any other package without `"type": "module"`, no longer has to change its module type (which also changes how its `.js` files run), and `init` stops asking for it. `.cts` files and dependencies keep their own format.

  `init` writes the engine version released alongside the CLI (`^0.7.0` for `@e2edev/playwright`) instead of `0.x`. Package managers resolve a range to the registry's `latest` tag whenever it satisfies, and `latest` trails the tag the runner installs from, so `0.x` fetched an old engine whose peer range rejected the runner.

- [#245](https://github.com/tester-army/e2e/pull/245) [`38d4424`](https://github.com/tester-army/e2e/commit/38d4424eb1fd2e16ab5fd2fb1fc6b64862ced3a7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A filled credential no longer leaves the runner inside a Playwright trace. The trace recorded the value as typed: in the `fill` action's parameters, in every DOM snapshot of the field, and in the request body that carried it, while the report marked the artifact `redaction: "complete"`. Once a secret was filled in an attempt, the runner now rewrites every text entry of that attempt's trace archives before any is registered, hashed, or handed to an artifact store: JSON records value by value, other text as text, replacing each credential value (as typed, JSON-quoted, HTML-escaped, and URL-encoded) with `<secret:name>`; a binary entry holding a credential's bytes is dropped, and the rest is carried as stored. A trace from an attempt that filled no secret is labelled `not-required`; one the runner could not rewrite is deleted (a path the engine returned outside the attempt's artifact directory is refused and left untouched), the attempt's `secondaryErrors` carry a `TRACE_WITHHELD` entry, and a required trace marks cleanup failed. The engine contract's `stopTrace` may now return every trace segment instead of one path, and each is registered. The secret redactor that guards observations, logs, and the cache now covers those encodings as well.

## 0.9.0

### Minor Changes

- [#241](https://github.com/tester-army/e2e/pull/241) [`5ccfa46`](https://github.com/tester-army/e2e/commit/5ccfa46308bcd0160f01227da91dfc1e5f1be0b7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `prepare` may return `{ workers }`: the worker cap the engine actually provisioned for the target, `1` to `info.slots`, for engines that only learn their capacity at run time (a device pool discovered from the booted devices). The scheduler honours it over the declared `workers`.

- [#238](https://github.com/tester-army/e2e/pull/238) [`43f1a34`](https://github.com/tester-army/e2e/commit/43f1a3478942fb9c8d108c0f4279333d86a37236) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `reporters` accepts reporter objects beside `list`, `json`, and `junit`, and
  those three are now reporters on the same contract. A `Reporter` has a `name`,
  an optional `onEvent` that sees every run event as the `list` reporter does,
  and an optional `onRunFinished` that receives the finished run (the report-1
  document, `projectRoot`, `reportPath`, `artifactsRoot`, `aiTracePath`) once
  the summary has printed, awaited for up to a minute and abandoned by a forced
  interrupt, with an `AbortSignal` that says so; the summary rows it resolves
  with print under the `list` summary. A
  reporter can never change the run's status or exit code: a failure, a timeout,
  or a malformed result is one line on stderr. That now holds for `junit` too:
  `junit.xml` is written after `report.json`, a write that fails is a stderr
  line rather than a `REPORT_WRITE_FAILED` run error, and `junitPath` is gone
  from the `run-finished` event. `--reporter` replaces the built-in ids only and
  never removes a reporter object, and reporter objects stay out of the config
  digest. `Report`, `RunEvent`, and `RunEventOf` join the main entrypoint so a
  reporter types its handlers. The CLI also exits as soon as the run ends: a
  managed app or service that shut down on `SIGTERM` no longer leaves its
  shutdown timer holding the process for up to ten seconds.

## 0.8.0

### Minor Changes

- [#231](https://github.com/tester-army/e2e/pull/231) [`b9f032b`](https://github.com/tester-army/e2e/commit/b9f032bc30b42a71abac9310239e3dd4a58a01be) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The act loop re-finds a target that went stale and scrolls further in one call.

  - A tap, type, press, or select whose node the engine reports stale is retried on the node the same descriptor matches in a fresh capture, up to twice, before the failure reaches the model. A list that remounts its rows between the observation and the action no longer costs a turn per attempt.
  - The built-in agent's `scroll` tool takes `times` (1 to 5) and scrolls three quarters of the box per swipe instead of half; every swipe is one recorded action, and the observation after a scroll waits briefly for a windowed or lazy list to render its next rows.
  - Several actions issued in one turn keep addressing the screen the turn saw: an id the newest observation no longer carries, because a look in between renumbered the tree (an engine that mints ids per observation) or the element remounted, is re-found by its descriptor in the newest screen when exactly one node matches.
  - A mutating project tool arms the same brief wait as a scroll, so a page that reacts to it is read after the reaction; a secret fill's origin authorization is bounded like the fill itself; pressing a key that only moves focus or the caret (Tab, arrows, Home, End, Page keys) is not reported as a control that did nothing.
  - Three failed actions in a row earn the model a notice to change approach; five force the conclusion, the way repeated identical calls already do.

- [#231](https://github.com/tester-army/e2e/pull/231) [`b9f032b`](https://github.com/tester-army/e2e/commit/b9f032bc30b42a71abac9310239e3dd4a58a01be) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The built-in agent reads action results after their effect and sends screen changes instead of whole screens.

  - After a tap, type, press, select, or navigate, the next observation waits, bounded to two seconds, for the screen to leave the shape the action was resolved against. A tap on a link reports the page it opened rather than the page it left; an action that changed nothing says so instead of returning a stale screen. Cached replays settle through the same wait.
  - Every action result and every `observe` after the opening screen reports only the lines that changed, keyed by the stable node ids and prefixed `added`, `changed` (with what the line read before), or `removed`. A node that only moved to another depth is not reported, and a screen cut at the observation byte limit reports no removals, since the nodes past the limit were left out rather than gone. A screen that changed mostly goes out whole again, and the full screen it replaced is elided, so the transcript prefix stays stable for prompt caching.
  - Clock-like text (`12:05`, `0:59:59`) is ignored when comparing screen shapes, so a ticking timer neither ends the wait for an action's effect nor keeps a screen from settling.
  - Several actions may be issued in one turn; they run in order and each reports its own changes. A failed action returns the failure with the current screen, so a stale id costs no extra turn.
  - `complete_step` accepts summaries up to 2000 characters instead of rejecting them past 500, and asks for a short handoff for the next step.
  - The prior-step ledger shows a replayed step's recorded verdict without the cache replay notice.
  - A targeted grammar action (tap, type, press, select, scroll, secret fill) is bounded by the smaller of `actionTimeout` and 15 seconds, so a tap blocked by an overlay reports what is in the way within seconds instead of sitting in the engine's actionability retry for the whole `actionTimeout`. Navigation keeps the full budget.
  - Engine errors thrown by an engine loaded from a config file are recognized structurally: a retryable stale-node race during an observation is re-read instead of failing the action, and step events record the engine code (`NODE_STALE`, `NOT_ACTIONABLE`) instead of `EngineError`.

- [#219](https://github.com/tester-army/e2e/pull/219) [`17cde5a`](https://github.com/tester-army/e2e/commit/17cde5a1284f94d84ed8024a22b0fde1a5b23f88) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.act` takes one options bag and resolves with what the step did.
  `params` moves inside the options: `act('x', undefined, { timeout })` becomes
  `act('x', { timeout })`, and `act('x', { email })` becomes
  `act('x', { params: { email } })`. The result is an `ActResult`, with the
  executor's `summary`, the `modelCalls` and `actions` the step spent, and
  `cache`, how the trace cache took part, instead of `{ ok: true }`.
  `ActOptions` and `ActResult` replace `AgentOptions` and `AgentResult`. A
  call in the old shape fails with `INVALID_ARGUMENT` naming the move, from a
  JavaScript test as from a typed one, instead of running with its parameters
  silently ignored.

- [#219](https://github.com/tester-army/e2e/pull/219) [`17cde5a`](https://github.com/tester-army/e2e/commit/17cde5a1284f94d84ed8024a22b0fde1a5b23f88) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A step in a retry attempt reports how the cache took part instead of
  nothing: `step.cache` (and `ActResult.cache`) reads `missed` with the new
  reason `retry`, since a retry records a trace but never replays one. Before,
  such a step was indistinguishable from one that ran with caching off. The
  report schema's `reason` enum gains the value.

- [#222](https://github.com/tester-army/e2e/pull/222) [`45f8a75`](https://github.com/tester-army/e2e/commit/45f8a756eb4f6b51f2521ace864a5287afbe7dc6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `app.deepLink(url)` is gone. It was `app.open(url)` under another name: the
  same navigation, the same base-URL resolution, the same origin policy, and no
  way to open a custom-scheme link, since a scheme outside the allowed origins
  fails the policy check. `app.open()` takes the absolute URLs `deepLink` took.

- [#224](https://github.com/tester-army/e2e/pull/224) [`96ae147`](https://github.com/tester-army/e2e/commit/96ae14755b2663d29d7f61107ff9271ab0a70dca) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `E2E_DEBUG` environment variable is gone, and with it the live stderr
  stream of agent phases and observations it switched on. The two diagnostics
  that stay are the ones the report and the CLI own: `e2e run --debug` for phase
  timings, transcripts, and the agent step table, and `e2e run --ai-trace` for
  every model call.

- [#236](https://github.com/tester-army/e2e/pull/236) [`571883e`](https://github.com/tester-army/e2e/commit/571883e61fcf64907ab39dd5a59009935837288c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `@e2edev/e2e/run` subpath is gone: `run()`, `RunOptions`, `RunOutcome`,
  and the event and record types it re-exported. The `e2e` CLI is the one way
  to drive the runner. A program that needs a run's outcome runs the CLI and
  reads `.e2e/report.json` (report-1), the canonical record of a run. The
  config seams stay where they were, in `e2e.config.ts`: `artifacts.store`,
  `cache.store`, `agent.executor`, and credential providers.

- [#226](https://github.com/tester-army/e2e/pull/226) [`adbc92c`](https://github.com/tester-army/e2e/commit/adbc92c928c6d1d28e65773ccbe58876f4de14a4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An engine declares the platform it drives, and a target inherits it.
  `Target.platform` is optional: with the name already defaulting to the
  platform, `{ engine: playwright({ url }) }` is a complete target, and so is
  `{ engine: agentDevice({ platform: 'ios', app }) }`. A target without an engine
  still names its platform. A target that names one while its engine declares
  another is `INVALID_CONFIG` instead of a label the tool packs silently disagree
  with. `Engine.platform` joins the engine contract as an optional member, and
  `e2e init` scaffolds targets without the redundant label.

- [#220](https://github.com/tester-army/e2e/pull/220) [`9cbba48`](https://github.com/tester-army/e2e/commit/9cbba48c62b319bba91b281f3451f9018513b675) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The judgment calls take named option types, and duration options drop the
  `Ms` suffix. `assert` takes `AssertOptions`; `waitFor` takes
  `WaitForOptions`, with `interval` where it had `intervalMs`; `extract` takes
  `ExtractOptions` and loses `maxModelCalls`, since its budget is fixed at two
  calls (one extraction plus one repair round) and the knob only ever accepted 1
  or 2. `longPress` takes `LongPressOptions`, with `duration` where it had
  `durationMs`. Every duration is still in milliseconds, like `timeout`. An
  option a call does not take, the old `intervalMs`, `durationMs`, and
  extract's `maxModelCalls` included, fails with `INVALID_ARGUMENT` instead
  of running on the default, from a JavaScript test as from a typed one; a
  renamed option is told its new name.

- [#237](https://github.com/tester-army/e2e/pull/237) [`cca3463`](https://github.com/tester-army/e2e/commit/cca34637f37b6a7af51d956a16257f7647ee9ed0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter's live window reads `Replaying` instead of `Thinking`
  while the trace cache has an `agent.act` step, from the moment a cached
  trace is found until the step ends or a replay that could not finish it
  hands the step to the model, when the row reads `Thinking` again.
  `StepProgress` gains the `replay` phase that carries this to any reporter:
  `{ phase: 'replay', api, active }`.

- [#233](https://github.com/tester-army/e2e/pull/233) [`a659f5f`](https://github.com/tester-army/e2e/commit/a659f5f5fcfc0fa97b5b460fa595d8bbf558cd0a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Opt-in run recording. `artifacts` accepts the `video` kind and `e2e run --video` adds it for one run; a recording lands under each attempt's artifact directory, is recorded in `report.json` as an artifact of kind `video` with `startedAt` (when the recording started, so step timestamps place onto it), and the failure recap names the file under each failed test. `artifacts.video.retain: 'on-failure'` keeps only the recordings of attempts that did not pass. Video never enters the config digest, so recording a run cannot invalidate its cached traces. Engines record through the new `startVideo`/`stopVideo` pair of `EngineArtifacts`; `run-started` events carry `artifactsRoot`; `StoredArtifact` carries `startedAt` for video. In report-1 an `incomplete` artifact may now carry `path`, `size`, and `sha256`: a video is recorded that way, since a recording masks nothing, and is kept as it is.

- [#225](https://github.com/tester-army/e2e/pull/225) [`47be7f8`](https://github.com/tester-army/e2e/commit/47be7f867da427cfa05f999c9af32ed5fd6eb6ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `selectOption` accepts `{ value }`, the option's `value` attribute, beside the
  label (a bare string or `{ label }`) and `{ index }`. Tests that know what the
  form submits no longer have to know what the option says.

- [#218](https://github.com/tester-army/e2e/pull/218) [`2e50798`](https://github.com/tester-army/e2e/commit/2e50798b3cbd4b813274a53889458eced830747d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A target's `name` is optional and defaults to its `platform`:
  `targets: [{ platform: 'ios', engine }]` is the target `ios`. Names stay
  unique, so two targets on one platform still name themselves; leaving both
  unnamed is `INVALID_CONFIG` with a hint saying so. Errors raised before a
  target's name is known (an unknown key, a missing platform) point at the entry
  as `targets[<index>]`.

- [#223](https://github.com/tester-army/e2e/pull/223) [`68620ef`](https://github.com/tester-army/e2e/commit/68620ef7459739f89f7846decd54af1c8e5105e9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `visible` is the one visibility option on `screen` queries. `RoleOptions.hidden`
  is gone: a role query never matches a node hidden from the accessibility tree,
  on every engine, the way a browser's role selector never does, and the one
  knob that widened it is no longer there to confuse with `visible`, which
  narrows every other query kind to nodes on screen. `SemanticQuery.states` on
  the engine contract loses its `hidden` key.

- [#232](https://github.com/tester-army/e2e/pull/232) [`25e1897`](https://github.com/tester-army/e2e/commit/25e1897fbbae245814b6622faf04fb29e8d59f9d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Worker slots and engine capacity. `EngineInitInfo.workerSlot` is the 0-based slot of the worker among its target's workers, the lowest one free when it was spawned, so an engine with several devices hands each slot its own. An engine declares `workers`, the most it serves per target at once; the scheduler never starts more for that target, whatever `config.workers` allows, so a device target shares a run with browser targets without being over-subscribed. `EnginePrepareInfo.slots` tells `prepare` how many worker slots the run will use.

### Patch Changes

- [#217](https://github.com/tester-army/e2e/pull/217) [`b526ea8`](https://github.com/tester-army/e2e/commit/b526ea82c1db2ab250f3db06412690bc7ff15a1b) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `act` observations are now clamped the way judgment observations already
  were: the tree an act turn sends is bounded by the per-call token ceiling
  minus what the rest of the request costs, so a dense screen truncates
  visibly instead of failing the adapter's pre-flight. The default
  `agent.maxObservationBytes` drops from 1048576 to 262144; set it explicitly
  to keep the old ceiling. The act loop also retries transport failures five
  times and bounds the whole loop by the step's remaining time, like the
  judgment calls, and `STEP_NO_CONCLUSION` reports how many turns the model
  used rather than the configured maximum.

- [#216](https://github.com/tester-army/e2e/pull/216) [`a372730`](https://github.com/tester-army/e2e/commit/a37273019732a2c9373d699bb5cafd35da4d2078) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `model` step events carry the moment the request went out as `startedAt`,
  not the moment the executor reported the turn. `ExecutorModelCall` gains an
  optional `startedAt`; the built-in tool loop fills it. The list reporter
  shows a step's events in stream order instead of moving each turn ahead of
  the tool calls it made.

- [#235](https://github.com/tester-army/e2e/pull/235) [`e7f0da5`](https://github.com/tester-army/e2e/commit/e7f0da56b022a3988361f6affb4a97409466df17) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter's `AI` summary row names the configured models after the
  call count, `provider/id` plus `vision provider/id` when `agent.visionModel`
  is set, so a long run's final summary carries them without scrolling back to
  the header. The `run-started` event gains an optional `visionModel` field, and
  the header names it too.

## 0.7.0

### Minor Changes

- [#192](https://github.com/tester-army/e2e/pull/192) [`593e179`](https://github.com/tester-army/e2e/commit/593e1799a88e73e02bd6ca9c85932bc9b705c377) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.act` no longer advertises options the runtime rejects. The `schema`
  overload (`AgentSchemaOptions`, `AgentResultWithData`) and the `vision`
  option are gone from the `Agent.act` type. Both threw `UNSUPPORTED_CAPABILITY`
  on every call, so no passing test changes; a call that passed either now fails
  to compile instead of at run time. Structured output is
  `agent.extract({ schema })`, and `vision` stays an option of `assert`,
  `waitFor`, and `extract`.

- [#211](https://github.com/tester-army/e2e/pull/211) [`1a74593`](https://github.com/tester-army/e2e/commit/1a745937ca41b61d7fed29c4506eafb5151855d8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI sends anonymous usage telemetry: one `e2e_cli_session` event per
  command (the command, its flags, the e2e, Node, and OS versions, the machine
  class, the CI vendor, the coding agent) and one `e2e_run_completed` event per
  run built from the report's own numbers (status, counts, durations, engine
  names, cache replay counts, model provider, token totals, error codes). Test
  names, file paths, URLs, instructions, messages, and credentials are never
  sent. Opt out with `e2e telemetry disable`, `E2E_TELEMETRY_DISABLED=1`, or
  `DO_NOT_TRACK=1`; `E2E_TELEMETRY_DEBUG=1` prints every event instead of
  sending it. Hosts embedding `@e2edev/e2e/run` send nothing.

- [#193](https://github.com/tester-army/e2e/pull/193) [`ee84c58`](https://github.com/tester-army/e2e/commit/ee84c582982628a23c3b9fb003d46d60d50ac076) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `isAgentError` is exported from `@e2edev/e2e`, next to `AgentError`. Test
  files load in their own module realm, so `instanceof AgentError` can be false
  for an error the runner threw; `isAgentError` checks a cross-realm marker and
  narrows to `AgentError`, so a test can branch on `error.code` without
  importing `@e2edev/e2e/agent`.

- [#170](https://github.com/tester-army/e2e/pull/170) [`22d3474`](https://github.com/tester-army/e2e/commit/22d347425d3c8ef4268690626c00aead9dd40e43) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - One model, checked once. The model passed to `createAgent({ model })` now
  serves the judgment calls (`assert`, `waitFor`, `extract`) as well as `act`,
  and outranks `E2E_MODEL`; an `agent.model` that names a different model is
  `INVALID_CONFIG`. The runner builds and validates the model adapter once per
  run, when the first test acquires the `agent` fixture. A missing model or
  credential is one run-level `MODEL_UNAVAILABLE` (exit 2) that stops the run,
  instead of one blocked step per test. Deterministic suites and custom
  executors without a model are unaffected.

- [#198](https://github.com/tester-army/e2e/pull/198) [`32b3724`](https://github.com/tester-army/e2e/commit/32b3724545785c7f451c7333fa0f078fcc55f8bc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `RunOutcome.status` and the `run-finished` event carry the same status as
  `report.run.status`, `blocked` included. A run whose every non-passing
  result was blocked (credentials, environment, or the agent's own budget) used
  to report `failed` to the host and `blocked` in `report.json`; the
  `RunStatus` type on `@e2edev/e2e/run` names the union.

### Patch Changes

- [#195](https://github.com/tester-army/e2e/pull/195) [`ce0b1a4`](https://github.com/tester-army/e2e/commit/ce0b1a437a65e9d58b1c6e4341de791ef8d5eac0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `ArtifactRecord.redaction` on `@e2edev/e2e/run` mirrors the report-1 schema:
  `'complete' | 'not-required' | 'incomplete'`. The type used to admit `'none'`,
  a value the schema rejects and the runner never wrote, and lacked the two the
  schema allows.

- [#210](https://github.com/tester-army/e2e/pull/210) [`bca2060`](https://github.com/tester-army/e2e/commit/bca2060b5b34f3d8f304ada21d5ef6685952377c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Two replay misses that were not the app's fault are gone. A target whose
  recorded fields matched several controls on the recording screen (one
  unlabeled "Set up" button per card, one "Add step" per gap) used to replay as
  `target-ambiguous` every time; the recorder now notes the target's `position`
  among those twins and a replay honors it when, and only when, the live screen
  shows exactly as many. End anchors no longer pick text that cannot read the
  same twice, such as a minted key prefix, a countdown, a date, or a clock
  time, while a stable anchor exists, so a step whose screen also shows such
  values stops handing off as `end-mismatch` on every run. A step that ends on
  another page now records that page's first stable anchors as well, and its end
  path is matched up to the ids the app mints per record, so a flow that creates
  a project and lands on it replays although the next project has a new id;
  before, such a step handed off as `end-mismatch` on every run and the agent's
  repair clicks evicted the recording each time.

- [#196](https://github.com/tester-army/e2e/pull/196) [`0898695`](https://github.com/tester-army/e2e/commit/08986951d94dc51d81e588878bad9799e860618a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init --help` describes `--yes` as it has behaved since init defaulted to
  Playwright: "Playwright, AI on, no installation". The old string still said
  "no engine".

- [#203](https://github.com/tester-army/e2e/pull/203) [`98f69b1`](https://github.com/tester-army/e2e/commit/98f69b1a78ab17d8d7890c2efebf458304a1ba77) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI help, the `e2e init` hints, and the agent skill link to the new documentation site at https://e2e-docs.vercel.app; the Fern-hosted site is retired.

- [#200](https://github.com/tester-army/e2e/pull/200) [`b30303e`](https://github.com/tester-army/e2e/commit/b30303eccb0a8ea33b44de0ac372eb7ec4c0d3c4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An interrupted run's summary names the interrupt. A Ctrl-C while the services
  or the app were still starting lands before test discovery, and the list
  reporter used to end such a run with `Test Files  no test files` and
  `Tests  no tests executed`, as if the globs had matched nothing. Those rows now
  read `none started (interrupted)` and `none executed (interrupted)`; a run cut
  after its plan arrived keeps its counters, which already show the shortfall
  against the planned total.

- [#208](https://github.com/tester-army/e2e/pull/208) [`3373b2e`](https://github.com/tester-army/e2e/commit/3373b2e2223f29f7b2992e71e4a08279c646eb08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replace inline base64 media in AI trace prompts and response messages with
  decoded byte counts, including structured tool content. This reduces trace
  size when image or file results recur in conversation history. URLs, text,
  and arbitrary tool result JSON are preserved; encoded strings outside SDK
  media message parts are not omitted.

- [#207](https://github.com/tester-army/e2e/pull/207) [`b6d259e`](https://github.com/tester-army/e2e/commit/b6d259e48ab90ef609f637fda352064ba8e56635) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Start app commands and services only for targets selected with `--target` or `run({ targetIds })`. Reject unknown target IDs before starting processes.

- [#201](https://github.com/tester-army/e2e/pull/201) [`b274f86`](https://github.com/tester-army/e2e/commit/b274f86fcb44a565d955dcdb919db714c9c03299) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The run narrates its setup and keeps it off the wrong clock. Everything
  before the first test is now a `setup` step on the event stream: `collect`,
  each target's engine `prepare`, and every service and app command, `started`
  then `finished` with its length (and `reused` when an already running process
  was attached). The runner validates the process declarations first, then
  collects, then provisions each engine, emits `plan`, and only then starts the
  services and app, so `NO_TESTS` is reported before any dev server boots and a
  missing browser is fetched before the app starts.

  The list reporter shows the step in flight with a ticking clock
  (`❯ preparing playwright engine for target "web" 12.30s`,
  `❯ starting service "postgres" 4.10s`), prints each finished process once
  (`✓ service "postgres" ready 41.20s`) and a provisioning step when it narrated
  (`✓ playwright engine for target "web" prepared 13.20s`), and an interrupt
  that lands during setup names the step it cut short (`interrupted while
starting service "postgres": tearing down`). `Start at` and `Duration`, and
  the report's `run.startedAt`,
  count from `plan`: a first-run browser download is not on the clock, while
  service and app startup is, split out as `(startup 41.20s)`. A run whose only
  test took 3s no longer reports 17s because Chromium was fetched first.

- [#204](https://github.com/tester-army/e2e/pull/204) [`9332274`](https://github.com/tester-army/e2e/commit/93322748f4988f7785908b144674dfe3689d56a7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Skip the trace cache's final observation when an agent step recorded no actions.
  Such steps produce no replayable trace, so they no longer wait for an unused
  end-state capture and settling cycle.

## 0.6.1

### Patch Changes

- [#190](https://github.com/tester-army/e2e/pull/190) [`8981e53`](https://github.com/tester-army/e2e/commit/8981e53f304f8e90559306b6e92df6b8f46ef71c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter prints each file, test, and agent step exactly once. The
  live window carries the in-progress tree - running tests with their finished
  steps, the current step's model turns and tool calls in causal order, and an
  animated `Thinking` indicator - at a fixed height so the summary stays put; the
  file block prints once the file completes, with agent steps nested under their
  test; on a TTY a file that ran agent steps lists its tests even when it passed,
  so the scrollback keeps them. The `RUN` banner names the configured model. Model events record
  `inputTokens` and `outputTokens` beside `count`, and `run-started` carries the
  configured `model`, both additive. The window repaints every 80ms instead of
  200ms so the indicator animates.

- [#174](https://github.com/tester-army/e2e/pull/174) [`ef21493`](https://github.com/tester-army/e2e/commit/ef21493e0eb756dcf2e7f19dec2effae032ddedb) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `E2E_MODEL_ENDPOINT` sets the model endpoint from the environment. It takes the
  same URL rules as `agent.model.endpoint` (HTTPS unless loopback), the config
  value wins over it, and the AI Gateway stays the default, so a run against any
  OpenAI-compatible endpoint needs only `E2E_MODEL`, `E2E_MODEL_ENDPOINT`, and
  `E2E_MODEL_API_KEY`.

## 0.6.0

### Minor Changes

- [`51ba502`](https://github.com/tester-army/e2e/commit/51ba50207bd0fab811a56cd11cf7a97530a90190) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The package ships an agent skill: `SKILL.md` plus one reference file per
  topic (`setup`, `writing-tests`, `agent`, `running`, `debugging`) that
  teaches a coding agent to configure e2e, write tests, and read a failing run.
  `e2e init` installs it into `.agents/skills/e2e/` and `.claude/skills/e2e/`
  (a prompt on the first run, a silent refresh of the existing copies after an
  upgrade), `e2e guide [topic]` prints it for an agent that lacks the files,
  and `npx skills add tester-army/e2e` installs it from the repository.

- [#178](https://github.com/tester-army/e2e/pull/178) [`eb46707`](https://github.com/tester-army/e2e/commit/eb467071b5b2e11a7c4e74dc6edb3c44490a4d43) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `e2e cache ls`, `e2e cache stats`, and `e2e cache clear` read and empty the
  trace cache. Until now the only controls were `--no-cache` and deleting the
  directory, and a reviewer of a committed cache had no way to see what it held:
  entry files are named after the digest of their key. `ls` prints the test, the
  target, the instruction digest, the age, and the action count of every entry,
  `stats` prints the entry count and the size, and `clear` deletes the store's
  files and the directory. Recorded traces now carry the test, target, and
  instruction digest they were recorded for, which is where `ls` reads them
  from; entries written by an earlier version replay as before and list with
  `-` in those columns.

- [#171](https://github.com/tester-army/e2e/pull/171) [`fe569f2`](https://github.com/tester-army/e2e/commit/fe569f25ec3236c98751b6dc2628ff82763e62eb) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `e2e list` prints the test-target pairs a run would select, one line per
  pair as `file › title [target]`, and exits without starting the app, an
  engine, or a worker. It takes the same files and selection flags as `e2e run`
  (`--config`, `--target`, `--tag`, `--tag-mode`, `--pass-with-no-tests`);
  `--reporter json` prints `{ "pairs": [...] }`.

- [#165](https://github.com/tester-army/e2e/pull/165) [`391f444`](https://github.com/tester-army/e2e/commit/391f444ff6e1f399ab71d057aa32c90f6b06c6db) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI has `--version` and a help worth reading. `e2e --version` (or `-v`)
  prints the installed version and exits 0. `e2e --help` opens with the version
  and tagline, lists the commands with examples, and points at the docs;
  `e2e run --help` groups the flags into Selection, Execution, and Output, then
  lists examples and the exit codes. `e2e help <command>` is the same as
  `e2e <command> --help`. Titles and flags are colored on a terminal and plain
  when piped or under `NO_COLOR`. A usage error now ends with
  `(add --help for usage)`.

- [#160](https://github.com/tester-army/e2e/pull/160) [`25a5838`](https://github.com/tester-army/e2e/commit/25a5838512ebb0942d9c248cb2befc226c305e28) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `defineConfig` is gone. An `e2e.config.ts` default-exports the object literal
  and ends it with `satisfies E2EConfig`, which gives the same completion and
  unknown-key checks without a runtime import from `@e2edev/e2e`.

  ```ts
  // before
  import { defineConfig } from '@e2edev/e2e';
  export default defineConfig({ targets: [...] });

  // after
  import type { E2EConfig } from '@e2edev/e2e';
  export default { targets: [...] } satisfies E2EConfig;
  ```

- [#163](https://github.com/tester-army/e2e/pull/163) [`9e2519d`](https://github.com/tester-army/e2e/commit/9e2519d1ed0c1b45d3c3cebed23de780c04ed617) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The first run of a new project fails with a sentence that names the fix, not a
  symptom. Walking through everything a first-time user does wrong:

  - `e2e init` without a terminal (a CI step, a pipe) used to wait forever on a
    prompt nobody could answer; it now exits 2 and names `--yes`. `e2e init
<directory>` scaffolds into that directory, creating it when missing, and the
    `next:` line starts with `cd`. An invalid `package.json` quotes the parser's
    position or the field with the wrong shape.
  - A Node.js older than 22.12 is told so, with both versions, before anything
    else loads.
  - `e2e run` with no config file is `CONFIG_NOT_FOUND` naming the directory
    searched and `e2e init`, and calls out `e2e.config.js` (or another
    look-alike) when that is what exists, instead of `targets is required`.
  - A failing import in the config or a test file says what to do: a declared
    but uninstalled package ends with `run pnpm install` (or the project's
    package manager), an undeclared one with the add command, a wrong subpath
    with the subpaths the package exports, `defineConfig` with its replacement,
    and a misspelled export with the nearest one.
  - `NO_TESTS` says why: no file matched the `tests` globs (naming
    `tests/login.test.ts` and other look-alikes beneath the globbed directories),
    a positional matched nothing (with the nearest discovered file), a file
    registered no tests (its `test` is imported from elsewhere), or every test
    was filtered, skipped, or is a setup test.
  - Unknown config, target, agent, cache, limits, and artifacts keys, unknown
    `--target` IDs and reporters, and unknown fixtures all suggest the nearest
    valid name. Keys from other runners (`testDir`, `baseURL`, `webServer`,
    `use`, `projects`, a `url` on a target) point at where that fact lives here;
    `page`, `browser`, `context`, `request`, and `driver` fixtures are explained
    in terms of `app`, `screen`, and `web`. Durations name their unit and quote
    the value: `timeout must be a positive safe integer of milliseconds, got "30s"`.
  - A test failure carries its `cause` chain, so the scaffold's HTTP check fails
    with `fetch failed: connect ECONNREFUSED 127.0.0.1:3000` rather than `fetch
failed`. `app.open()` against an address where nothing listens is
    `APP_UNREACHABLE` with the URL and the three ways to fix it, not an engine
    failure. A target without an engine says so when `screen` or `agent` is
    used, and names the two first-party engines.
  - A rejected model credential names the variable it was read from
    (`E2E_MODEL_API_KEY`, `AI_GATEWAY_API_KEY`, or the configured `apiKeyEnv`)
    rather than the gateway's own default, and ANSI color codes in provider
    messages no longer reach the report or the terminal.

- [#172](https://github.com/tester-army/e2e/pull/172) [`4818d70`](https://github.com/tester-army/e2e/commit/4818d70b296f32d0abddae47fc5bca454827d068) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `e2e init` defaults to the Playwright engine, both as the first wizard choice
  and under `--yes`, with AI enabled; `None` and `agent-device` stay selectable.
  The generated config reads `APP_URL` (default `http://localhost:3000`) and
  shows the `command` option and `createAgent({ model })` in comments. The
  example test opens `/` and asserts `web.locator('body')` is visible, so it
  passes against any page with no model key. `package.json` gains a
  `test:e2e` script when missing, engine dependencies use `0.x` instead of the
  `beta` tag, `init` suggests a `tsconfig.json` when none exists, and the
  closing line prints `APP_URL=http://localhost:3000 npx --no-install e2e run`.

- [#177](https://github.com/tester-army/e2e/pull/177) [`7e5b0cf`](https://github.com/tester-army/e2e/commit/7e5b0cffc2ce8a39e003ffc90ade25f8dd1e0a18) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Judgments work on reasoning models. The judgment output cap is 8192 tokens
  so hidden reasoning no longer eats the answer, `agent.assert` has two model
  calls so a malformed response gets one repair round, and the adapter no
  longer pins `temperature: 0`, which reasoning models reject. A new
  `agent.providerOptions` config key sends AI SDK provider options (a reasoning
  effort, a thinking budget) with every model call of both the `act` and the
  judgment tiers.

- [#175](https://github.com/tester-army/e2e/pull/175) [`766cf52`](https://github.com/tester-army/e2e/commit/766cf52c0db44be69d05079fa4f97726c3e5fa15) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Node.js 22.12 is the floor. Node 20 reached end of life in April 2026; the
  `engines` field, the CLI's startup check, and the docs now all say 22.12.

- [#167](https://github.com/tester-army/e2e/pull/167) [`bbe8420`](https://github.com/tester-army/e2e/commit/bbe842042737f5df92766628429e5eb1cf67239f) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - Add `toBeFocused` and `toHaveAttribute` locator matchers, and make `getAttribute` read any attribute present on the element.
  Add `expect(web).toHaveClass(target, expected)` to the web fixture.

### Patch Changes

- [#162](https://github.com/tester-army/e2e/pull/162) [`203e938`](https://github.com/tester-army/e2e/commit/203e9385a23a63d1ed103eb54804c4951a0c751a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter paints target badges on bright backgrounds. GitHub Actions
  renders the plain yellow background as dark brown, which made the first
  target's black label unreadable in CI logs.

- [#173](https://github.com/tester-army/e2e/pull/173) [`a312d5b`](https://github.com/tester-army/e2e/commit/a312d5b9256e59470266d5e65e14289b5148c63c) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - `e2e init` prints a pointer to the new "Commit your traces" section of the
  config reference when it adds `.e2e/cache/` to `.gitignore`. Committing cache
  entries is opt-in; the section says how to opt in and what CI does with a
  committed cache.

- [#161](https://github.com/tester-army/e2e/pull/161) [`41612dc`](https://github.com/tester-army/e2e/commit/41612dcf44e6e395d578a23c09cf1dd451231095) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Package and CLI descriptions no longer call e2e a "standard".

- [#168](https://github.com/tester-army/e2e/pull/168) [`1ef5b00`](https://github.com/tester-army/e2e/commit/1ef5b003b62a588f554ad567f9d1f4540ffd8b35) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - READMEs and CLI help use the scoped package names (`@e2edev/e2e`,
  `@e2edev/playwright`, `@e2edev/agent-device`) on every install line, point at
  the Fern docs instead of e2e.dev, and describe e2e as an open framework for
  agentic end-to-end testing.

- [#176](https://github.com/tester-army/e2e/pull/176) [`cef82f8`](https://github.com/tester-army/e2e/commit/cef82f8e46c9f8ffbd79fa96b1dcc7843ea5dca5) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - A third Ctrl-C kills the process groups of every app command and service the
  run started before exiting, so they no longer survive the forced exit and
  fail the next run with `APP_ALREADY_RUNNING`.

- [#159](https://github.com/tester-army/e2e/pull/159) [`2bd509d`](https://github.com/tester-army/e2e/commit/2bd509d263b6b5a06d697261ab70d4df21926ba6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `Role` accepts the landmark roles (`main`, `navigation`, `banner`, `contentinfo`,
  `complementary`, `region`), `alertdialog`, and the structural and form roles the
  engines already report in observations (`searchbox`, `combobox`, `listbox`,
  `option`, `radio`, `list`, `table`, `row`, `cell`, `columnheader`). Scoping a query
  to the page's main content or a confirmation dialog no longer needs a platform
  selector such as `web.locator('main')` or `web.locator('[role="alertdialog"]')`:
  `screen.getByRole('main').getByText('Release website')` is portable. The Playwright
  engine resolves every role through Playwright's own accessibility engine, and the
  device engine matches the roles its node mapping produces; roles a platform never
  reports simply match nothing, as before.

## 0.5.0

### Minor Changes

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The app under test is declared by the engine that drives it, not by the
  config. The top-level `app` key (`url`, `command`, `readyUrl`, `services`,
  `allowedOrigins`, `environment`, `identity`) is gone, and so is the runner's
  `APP_URL` fallback: the browser engine takes the same fields as options,
  `playwright({ url, command, services, ... })`, and the device engine derives
  the identity from the app it pins (`agentDevice({ platform, app })`, or an
  explicit `identity`). Two web targets on one app each name it; services and
  commands declared identically by several targets start once.

  For engine authors, the `app` manifest of `defineEngine` carries the
  declaration (`EngineAppDeclaration`) beside its hooks, and the runner
  resolves it per target: navigation policy, cache and session identity, the
  report's target record (`baseOrigin` is now absent for a surface without a
  URL), and the app process all read from there. A device target can finally
  declare a stable identity without inventing a URL. `@e2edev/e2e/engine` also
  exports `obj`, the one-call replacement for the conditional-spread
  idiom when a declaration is built from optional inputs.

  Migrate by moving the `app` block into the engine factory:

  ```ts
  // before
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', engine: playwright() }],
  // after
  targets: [{ name: 'web', platform: 'web', engine: playwright({ url: 'http://localhost:3000' }) }],
  ```

- [#151](https://github.com/tester-army/e2e/pull/151) [`d4489c0`](https://github.com/tester-army/e2e/commit/d4489c06be7b9b5270c29361af9830003da947bb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Removes public API that had no consumer, was deprecated, or duplicated another surface, so what remains is what the runner actually enforces.

  - `ExecutorBudgets.recordToolCall` (deprecated): use `runTool`, which reserves the action budget before the tool body runs.
  - `ToolAnnotations.replay` and `ToolAnnotations.secrets` (deprecated, never read): `defineTool` takes `{ mutates, platforms? }`.
  - `StepExecutorContext.priorSteps` and `ExecutorPriorStep`: the ledger string is the executor's prior-step context.
  - `createToolLoopExecutor` options `onConclude`, `loopGuards`, and `windDown` (and the `WindDownPolicy` / `LoopGuardThresholds` types): the chassis keeps its own loop guards and wind-down policy.
  - The `@e2edev/e2e/agent` primitives `createGrammarTools`, `createVerdictTool`, `trackModelCalls`, `conversationMemory`, `VERDICT_RULES`, `serializeLedger`, `compactSnapshotHistory`, and `formatReplayedPrefix`: `createAgent` and `createToolLoopExecutor` are the two supported layers.
  - `blockedCategoryOf` and `BlockedCategory` from the main entrypoint.
  - The legacy fixture adapter: an engine fixture factory must return the surface it declared through `context.fixture`; a plain surface is rejected with `INVALID_CONFIG`.

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rename the "backend" concept to "engine" everywhere. The authoring import is now `@e2edev/e2e/engine` (`defineEngine`, `EngineHandle`, `EngineError`, `EngineFixtureContext`, ...), a target names its engine as `engine: playwright()` in `e2e.config.ts`, the error code `BACKEND_FAILURE` is now `ENGINE_FAILURE`, and the `backend` provenance field in the report and session schemas is now `engine`. `@e2edev/e2e/backend`, `defineBackend`, `backend:` and `BACKEND_FAILURE` are gone; update the import path, the config key, and any code matching on the error code or reading provenance.

- [#156](https://github.com/tester-army/e2e/pull/156) [`0e5e1ef`](https://github.com/tester-army/e2e/commit/0e5e1ef1a245674a198e3708f1c06db4c290bd39) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `list` reporter is laid out like vitest's default reporter. Results print
  one block per test file and target - a colored target badge, the file, its
  counts, and its duration - with every test listed when the file failed, had a
  flaky pass, streamed its steps, or is the run's only file. Failures move to a
  `Failed Tests` section at the end, each with its error, the failing line, and
  a vitest-style code frame, followed by a padded summary (`Test Files`,
  `Tests`, `AI`, `Start at`, `Duration`, `Report`). On a TTY a live window
  shows the running files and tests with elapsed times, the current step and
  its latest model or engine calls, and the running counters. Colors follow
  picocolors' detection, so CI logs are colored too.

  For hosts on the event stream, `plan` now carries `files` (reportable pairs
  per test file and target) and `test-started` carries the test's `file` and
  `serialId`. A serial group announces every member as it begins, not just the
  first, and `serial-group` is emitted before its members' `test-finished`
  results, so each member's duration, usage, and error can be attributed.

### Patch Changes

- [#141](https://github.com/tester-army/e2e/pull/141) [`e26e1d8`](https://github.com/tester-army/e2e/commit/e26e1d8fa9714930b9ea33f9a3bbadb7a1f89102) Thanks [@okwasniewski](https://github.com/okwasniewski)! - CI now demotes the trace cache to `read-only` only when the config left `mode` unset. An explicit `cache: 'read-write'` (or `{ mode: 'read-write' }`) is honored in CI as the project's own statement that it trusts the cache it restores, for example one carried between runs by the CI provider's cache service rather than committed to git. `--no-cache` still wins over the config, and a custom `cache.store` keeps stating its own trust through `writable`.

- [#143](https://github.com/tester-army/e2e/pull/143) [`57a313d`](https://github.com/tester-army/e2e/commit/57a313d021ad3f800188e07ffffd3f3d2209d17d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An engine's `command`, every `services` entry, and every service `teardown` accept a `log` path. When set, the runner appends the process's stdout and stderr to that file (resolved from the project root, kept inside it through symlinks, parent directories created) instead of discarding them, so a dev server that dies on boot or a migration that fails can be read back without wrapping the command in a shell redirect. Output is still discarded when `log` is unset. The file is unredacted, so `e2e init` now also adds `.e2e/logs/` to `.gitignore`.

- [#147](https://github.com/tester-army/e2e/pull/147) [`a3f9ad7`](https://github.com/tester-army/e2e/commit/a3f9ad7190f2ce5212bd98e2f52d1b7b8f1e27b0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An engine's `command` and its `readyUrl` services accept `reuseExisting: true`: when the readiness URL already answers before the spawn, the runner attaches to that process instead of starting its own, reports `<label>: reusing the process already serving <url>`, and leaves it running on teardown (a reused service also skips its `teardown`). Off by default. CI ignores the flag with a notice. Setting it on a `waitForExit` service or a `teardown` command is `INVALID_CONFIG`.

  The runner now always probes `readyUrl` once before spawning, within `startupTimeout`. Without `reuseExisting` in effect, a URL that already answers fails the launch with the new `APP_ALREADY_RUNNING` (infrastructure, exit 3) instead of letting the old server pass as the new command's readiness, so tests no longer run against stale code by accident.

- [#146](https://github.com/tester-army/e2e/pull/146) [`78f1e9b`](https://github.com/tester-army/e2e/commit/78f1e9b320ecea702f93df482eb07d85b73b4801) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run [files...]` now accepts directories and globs, not only exact file paths. A directory selects every test file the config globs discover beneath it (`e2e run tests/agent`), a glob uses the config `tests` grammar (`e2e run 'tests/**/*.smoke.e2e.ts'`), and a file path still matches exactly. Positionals keep narrowing the config globs and must stay inside the project root. When nothing is left to run, the `NO_TESTS` message names each positional that matched no file, so a mistyped path is visible instead of failing silently.

- [#144](https://github.com/tester-army/e2e/pull/144) [`44ee0a2`](https://github.com/tester-army/e2e/commit/44ee0a2786fa1027bcc12eb6afddcf177899fd45) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `app.services[]` entries accept an optional `name`. Errors from a service that fails to start, never becomes ready, or whose teardown fails now read `service "postgres" exited with code 1 instead of 0` rather than naming the service by its position and full command line, which was unreadable behind a shell wrapper. The name defaults to the executable's base name; an explicit name must be a non-empty string of at most 64 characters and unique across the named services, otherwise `INVALID_CONFIG`.

- [#149](https://github.com/tester-army/e2e/pull/149) [`f810e23`](https://github.com/tester-army/e2e/commit/f810e2324b02b189cbbb6242a55da5d587285932) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every `screen` query accepts `visible: true`, which drops nodes the platform reports as hidden before the exactly-one rule runs: `getByText('No memories yet', { visible: true })` resolves the copy a person sees even while a framework keeps a `display:none` twin in the document after a reload. Omitted or `false` keeps every match, so existing `LOCATOR_AMBIGUOUS` failures still fire. The predicate is the node's own `hidden` state, the one `toBeVisible()` reads, and it composes with scopes, `filter`, `first`, `last`, and `nth`. `getByTestId` gains the same optional `{ visible }` argument.

  The engine contract's `SemanticQuery` carries the flag as `visible`; the Playwright and agent-device engines evaluate it from the hidden state they already report, and the harness holds a top-level query to the same predicate as a backstop.

## 0.4.0

### Minor Changes

- [#136](https://github.com/tester-army/e2e/pull/136) [`686a2fa`](https://github.com/tester-army/e2e/commit/686a2fa95c37123eff3c936f2069f8500e012274) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Add `app.services`: ordered dependency processes (a database container, a cache, an auth emulator, a migration step) that start sequentially before `app.command`, each ready before the next via a `readyUrl` probe or `waitForExit: true`, and are torn down in reverse on every exit path, followed by each service's optional `teardown` command. A service with neither readiness contract is `INVALID_CONFIG`; a readiness failure is `APP_UNREACHABLE` naming the service; a failing teardown is a `cleanup`-phase run error. Service and teardown `env` values enter the config digest as names only, like `app.command.env`. `app.readyUrl` is now validated as an absolute http(s) URL at config time, the same rule a service `readyUrl` follows, and `app.command` startup errors name it `app.command` rather than `app command`.

- [#125](https://github.com/tester-army/e2e/pull/125) [`20c5d4a`](https://github.com/tester-army/e2e/commit/20c5d4ad404e90df8f54831e063d26536fae0073) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The harness is a notary, not an author: it witnesses and bounds what a step
  executor does and no longer decides what the executor's model reads.

  The executor context gains `attempt` (test id, attempt id, retry index, an
  end-of-attempt signal, and a per-attempt `memory` map the harness holds and
  never persists or reports), `step.index`, and `priorSteps` — the completed
  steps as structured, sanitized records beside the existing `ledger` string.
  `observe({ tree, pixels })` opts into the redacted node tree and masked
  viewport pixels; pixels are withheld with a reason after a secret fill, when
  masking is unproven, or when the backend has none. A `StepExecutor` may
  declare `cache: 'off'` so every one of its steps reaches `runStep` instead of
  a cached replay.

  The agent surface is layered like the AI SDK. `createAgent` is unchanged:
  the golden path, five options. `createToolLoopExecutor` is where the model's
  reading is shaped: `buildPrompt` may return a message history, and it gains
  `onConclude(ctx, { messages, verdict })` plus `loopGuards` / `windDown`
  policy. New primitives from `@e2edev/e2e/agent` compose with the chassis or a
  raw `ToolLoopAgent` and load no `ai` themselves: `createGrammarTools`,
  `createVerdictTool`, `trackModelCalls`, `conversationMemory`, plus the
  exported `serializeLedger`, `compactSnapshotHistory`, and
  `formatReplayedPrefix`. The chassis is rebuilt on those primitives. A model
  that remembers every step of a test is the chassis, the grammar tools, and
  `conversationMemory`.

  Spec chapter 10 now states what the ledger must guarantee (deterministic,
  bounded, never model-produced, never carrying secrets) instead of prescribing
  the serialization algorithm, which becomes the reference runner's exported
  default.

- [#137](https://github.com/tester-army/e2e/pull/137) [`cec8cee`](https://github.com/tester-army/e2e/commit/cec8ceeac3d07ddbe0572cdee36ad341d68e0d7f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Add a `junit` reporter. Selected with `reporters: ['junit']` or `--reporter junit`, it renders the run's `report-1` document as JUnit XML and atomically writes `.e2e/junit.xml` beside `report.json`, on every outcome where the report is written: one `<testsuite>` per test file, one `<testcase>` per test-target pair, `<failure>` for test-category errors, `<error>` for infrastructure and configuration errors, `<skipped>` with the reason, and a `run` suite carrying run-level errors such as `APP_UNREACHABLE`. It combines with `list` or `json`. `RunOutcome` and the `run-finished` event carry `junitPath`, the list reporter prints it, and `e2e init` gitignores the file.

- [#132](https://github.com/tester-army/e2e/pull/132) [`bc87f15`](https://github.com/tester-army/e2e/commit/bc87f15b3b62258f8e9c059873e1f89a67ba27de) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Keep secret redaction and pixel taint with the live session across serial members. Route device model screenshots through guarded observations and reserve project-tool action budgets before dispatch, serializing mutations with grammar actions.

  Add explicit fixture operation declarations, preserve legacy factories, mark contributed assertions as verification steps, and isolate asynchronous step attribution. Share cancellation helpers; deprecate optional tool annotations whose replay and secret semantics are not implemented.

  Preserve fixture object identity and mutable state when recording declared operations, and retain artifacts and viewport metadata attached before a legacy synchronous failure.

  Bound device located references and reuse snapshot location metadata. Both reference backends require e2e >=0.4.0 for the new fixture and lifecycle helpers.

### Patch Changes

- [#135](https://github.com/tester-army/e2e/pull/135) [`1d1e37e`](https://github.com/tester-army/e2e/commit/1d1e37e648e431199b4bdd08dc3315535856fbc3) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - `e2e init` now sets up the package, not only the files: it creates a private ESM `package.json` when none exists, adds the runner and the chosen packages to `devDependencies` while preserving existing versions and module type, and offers to install them with the project's package manager. The wizard picks a backend (none, Playwright, or agent-device, defaulting to iOS on macOS and Android elsewhere) and whether to enable AI testing; `--yes` enables AI with no backend and no installation.

  Loading a `.ts` config or test outside an ESM package now fails with an actionable message instead of a loader error.

- [#130](https://github.com/tester-army/e2e/pull/130) [`2b3342d`](https://github.com/tester-army/e2e/commit/2b3342df89368de73ca27d5fe419d85c1c3b1c94) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Share model usage accounting between executor steps and judgment calls. Keep missing, partial, or estimated usage marked as adapter-upper-bound and reject invalid token counters and costs.

  Sanitize judgment event counts before recording them. Cap unrepresentable token sums, mark their accounting non-authoritative, and omit overflowing cost totals.

- [#126](https://github.com/tester-army/e2e/pull/126) [`15ebb46`](https://github.com/tester-army/e2e/commit/15ebb465b883047b6afb0d126ab6c4a0cdaf9fb9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A replayed step that navigates now waits for its recorded destination path
  before the end state is judged. A step that moved to another pathname records
  no anchors; the path is its whole postcondition, and the replayed tap that
  starts the navigation returns before the new document commits. The replay read
  the path once, right there, so every cross-page replay handed off as
  `end-mismatch` and the executor paid for the step again. The path is polled
  with the same settling backoff anchors use (100 to 3000 ms, 15 s cap, bounded
  by the step budget), and a navigation step self-finalizes zero-turn like a
  same-page one.

## 0.3.0

### Minor Changes

- [#117](https://github.com/tester-army/e2e/pull/117) [`44ce280`](https://github.com/tester-army/e2e/commit/44ce280e92772b452b6a958bf1a606b43e7cdba3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Install builds on the device. The `appPath` backend option installs an iOS
  `.app` bundle or Android `.apk` once per worker, after boot and before the
  first attempt; without `app`, the installed bundle id or package becomes the
  app opened fresh per attempt, so `agentDevice({ platform: 'ios', appPath:
'./build/MyApp.app' })` is a complete target. The `device` fixture gains
  `installApp(appPath, { app, reinstall })` for tests that exercise upgrade or
  fresh-install paths, recorded as a `device.installApp` step.

  `BackendInitInfo` carries `projectRoot`, the directory relative config paths
  resolve against, so a backend option naming a file resolves the same way in a
  child-process worker and an in-process run.

- [#113](https://github.com/tester-army/e2e/pull/113) [`6a2918c`](https://github.com/tester-army/e2e/commit/6a2918cf98117d5c06a815422498923ee2c1c043) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Foundation work for executors that diff screens and replay long flows
  reliably; no behaviour of the built-in agent changes beyond its history hook.

  Chassis (`createToolLoopExecutor`): `prepareMessages(messages, turn)`
  replaces `compactMessages`. It runs between turns, its result carries forward
  to later turns, and it may return `{ messages, stop }` to force the
  conclusion when the executor has evidence the loop guards cannot see.
  `providerOptions` are passed to every model call. `createAgent` accepts
  `providerOptions` too. `isDefinedTool`, `toolAppliesTo`, `PreparedTurn` and
  `PreparedMessages` are exported from `@e2edev/e2e/agent`; `RUNTIME_CODES` from
  `@e2edev/e2e`. `ExecutorObservation` carries the current `path` when the
  backend reports one.

  Trace cache: a typed value that appears in neither the step's instruction
  nor its params was derived at run time and is recorded as a gap, so replay
  hands the step over before it instead of typing a value the app may not
  issue again. A trace records how long the recording run took to reach its
  end state (`endWaitMs`), and replay waits that long (plus a margin, bounded
  by the step clock) for the end anchors before it self-finalizes. Every
  targeted action records the key of the row or list item it sat in
  (`within`), and relocation requires it to hold, so same-named controls in
  different rows replay without a guess. The replay policy version bumps, so
  existing caches cold-start.

  Breaking for `createToolLoopExecutor` callers: `compactMessages` is replaced
  by `prepareMessages`.

- [#115](https://github.com/tester-army/e2e/pull/115) [`b08a668`](https://github.com/tester-army/e2e/commit/b08a668eed39e3d68b5f5d15335eef9895bdb15f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Backends get a `prepare` hook: once per run and target, in the runner process,
  before any worker starts and outside every launch budget. The Playwright
  backend installs a missing browser there instead of inside `init`, so a
  first-run download is no longer charged against `launchTimeout`, no longer runs
  once per worker, and its progress streams as new `notice` run events. The list
  reporter prints those above its live status block, where before the block's
  repaint erased the download output written to a worker's stderr and a first run
  looked hung on a spinner.

- [#116](https://github.com/tester-army/e2e/pull/116) [`e73e4f2`](https://github.com/tester-army/e2e/commit/e73e4f27ca8a4a863d2d142a2bc05983b2ae2057) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `app.url` and `APP_URL` no longer need a scheme: `tester.army` becomes `https://tester.army` and `localhost:3000` becomes `http://localhost:3000`. The `allowProduction` gate is gone and `app.environment` is no longer required for non-loopback hosts; it defaults to `test` for loopback, `.localhost`, and `.test` hosts and to `production` elsewhere, and stays a label for the report and the cache identity. `allowProduction` is now an unknown app key (`INVALID_CONFIG`), and the report target no longer carries it: readers that require `targets[].allowProduction` must drop that requirement. `e2e init` now scaffolds `app: { url: 'localhost:3000' }`, `agent: createAgent({ system })`, and one playwright web target, and warns when the `ai` peer dependency is not declared.

### Patch Changes

- [#118](https://github.com/tester-army/e2e/pull/118) [`749988f`](https://github.com/tester-army/e2e/commit/749988f923e7905a36c4898e0037b8af06eff23c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ctrl-C now ends the run and tears the backend down. The first signal interrupts the running test immediately (it no longer waits for the test timeout when the body is not calling the harness), runs its bounded cleanup, disposes every worker's backend, and writes the report. A second signal forces every worker to dispose at once and kills it after the cleanup budget; a third exits on the spot. A worker whose runner disappears disposes its backend and exits instead of running on. The event stream gains `run-interrupted`.

  The signal ladder is the CLI's. `run()` from `@e2edev/e2e/run` no longer installs `SIGINT`/`SIGTERM` handlers and never exits the process; a host passes `interruptSignal` and the new `forceSignal` instead.

- [#119](https://github.com/tester-army/e2e/pull/119) [`00cfc52`](https://github.com/tester-army/e2e/commit/00cfc52bd5a9ab56f7fb2dad357ce325c9ce4817) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Hooks now run in the order the lifecycle spec defines. `beforeEach` runs outer
  scope to inner and `afterEach` inner to outer regardless of where in the file
  each scope's hooks were declared; before, a file-level hook declared below a
  `test.describe` ran after (or, for `afterEach`, before) the group's own hooks.
  A `describe`'s `afterAll` runs when its last test in the realm finishes rather
  than when the whole file ends, so one group's teardown no longer lands after a
  sibling group's tests. Sibling groups that share a title keep separate hooks.
  A failing `afterAll` discards the realm as the spec requires: later tests start
  fresh, and a serial group attempt ends with its remaining members skipped.

  Each `afterEach` hook gets its own `cleanupTimeout` budget with working
  fixtures: after a body timeout, teardown can still drive the app instead of
  failing with `operation cancelled`; a hook that overruns its budget fails, its
  fixture operations are cancelled, and the next hook still runs. The agent-device
  `device` fixture reads that signal per call, so it too keeps working in teardown.

  Suite-hook run errors carry a readable `scopeId` (`file` or the group title
  path); an `afterAll` failure at file scope no longer writes an empty
  `scopeId` the report schema rejects.

## 0.2.0

### Minor Changes

- [#87](https://github.com/tester-army/e2e/pull/87) [`5d6dc2b`](https://github.com/tester-army/e2e/commit/5d6dc2bc9bc6d3bf7b579a5cde3cead40f6da919) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The located agent verbs and the locator cache are removed. `agent.act` is the
  one agent action API.

  Breaking:

  - `agent.tap`, `agent.click`, `agent.type`, `agent.scroll`, `agent.scrollTo`,
    `agent.longPress`, `agent.press`, `agent.select`, `agent.hover`,
    `agent.check`, `agent.uncheck`, `agent.dragTo`, `agent.upload`, and
    `agent.login` are gone, along with `InstantActionOptions`. Every located
    action is one `agent.act` instruction; sign-in is `agent.act` with `Secret`
    params, which the runner fills host-side so the plaintext never reaches the
    model.
  - `agent.assert`, `agent.waitFor`, and `agent.extract` stay, as does the whole
    deterministic tier. `vision: 'fallback'` now behaves like `false` for these
    methods: a judgment always produces an answer from the tree, so there is no
    miss to escalate on.
  - The locator cache (cache-1) is removed: the `agent.cache` config key, the
    `--no-agent-cache` CLI flag, `limits.maxCacheBytes`, the report's
    `step.cache` and `usage.maxCacheEntryBytes` fields, and the
    `CACHE_REPLAY_DIVERGED` error code no longer exist. v0 performs no caching.
  - Conformance `suiteVersion` bumps to 0.3.0; the `cache-1` profile and the
    `agent-locate-1` schema are withdrawn.

- [#92](https://github.com/tester-army/e2e/pull/92) [`6a64197`](https://github.com/tester-army/e2e/commit/6a64197e17a288bfe06b3f6f6e79297f836db686) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `actionTimeout` now bounds every driver operation inside agent steps —
  observations and grammar actions in both the act and judgment tiers.
  Previously each in-step driver call could run to the step's remaining
  deadline, so a single page that never settled could consume an entire act's
  budget (observed live: one hung observation burning 581s of a 600s step).
  Now such a call fails within one `actionTimeout` with a clearly attributed
  error, the executor decides what to do next, and per-call `timeout` options
  on production suites become unnecessary. Suites that relied on a single slow
  navigation inside an act getting more than `actionTimeout` should raise
  `actionTimeout` explicitly.

- [#86](https://github.com/tester-army/e2e/pull/86) [`347aa7d`](https://github.com/tester-army/e2e/commit/347aa7ded66fd774ffe859399a3c030cd405df3b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.act()` ships on a harness-owned step-executor socket (RFC0001 v0).

  The harness owns each planned step — observation redaction, the action
  grammar (`tap`, `type`, `typeSecret`, `press`, `select`, `scroll`,
  `navigate`), budgets, deadlines, origin policy, and recording — and delegates
  only the thinking to a pluggable `StepExecutor`, configured as the `agent`
  value itself: `agent: createAgent({...})` or any hand-rolled executor (there
  is no `executor` key). The `@e2edev/e2e/agent` entrypoint exports `createAgent` (the
  built-in AI SDK tool-loop executor), `createToolLoopExecutor` (the chassis:
  verdict tool, hard stops, loop guards, wind-down, `--debug` transcripts), and
  `defineTool` for annotated project tools. Verdicts are ternary: `blocked` is first-class
  in the report (step and run status) with a closed category taxonomy
  (credentials, environment, seed_data, test_setup, automation). `Secret`
  values flow into `act` params as placeholders and fill only through the
  authorized `typeSecret` action. With a custom executor, `agent.assert` also
  dispatches through the socket.

  Breaking changes:

  - The AI SDK (`ai`) is now an optional peer dependency (`^7.0.0`) instead of
    a hard dependency. Model-backed calls require it installed; deterministic
    suites and custom executors run without it.
  - `reporters` accepts only `'list' | 'json'` (the unimplemented `'html'`
    value is removed) and defaults to `['list']`.
  - The `limits` block accepts only enforced keys; the ten
    validated-but-unenforced keys (`maxDiscoveredResults`, `maxArtifactBytes`,
    `maxArtifactTotalBytes`, `maxDownloadBytes`, `maxDownloads`,
    `maxReportBytes`, `maxTerminalFieldBytes`, `maxModelCallsPerStep`,
    `maxActionStepsPerStep`, `maxEstimatedCostUsd`) are rejected.
  - `report-1` documents changed (limits/usage blocks, `blocked` statuses, new
    error codes); the conformance `suiteVersion` is now 0.2.0.
  - `verifyDriver` and its conformance types are removed from `@e2edev/e2e/driver`
    until the harness can actually run vectors.

- [#104](https://github.com/tester-army/e2e/pull/104) [`ced765a`](https://github.com/tester-army/e2e/commit/ced765a3d3fa787910180ea3c52f5d410ed4c11f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run --ai-trace` records every model call of a run to `.e2e/ai-trace.json`
  in the AI SDK devtools database shape (`{ runs[], steps[] }`), so a trace
  viewer such as unbox-ai opens it as is: `npx unbox-ai .e2e/ai-trace.json`.

  Each agent step is one run named after the test and the step
  (`todos › adds one · agent.act "add a todo"`), with one entry per model round
  trip: an `act` turn, a `waitFor` poll, a judgment's repair round. A generation
  a project tool makes nests under its caller. Every entry carries the prompt as
  sent (system prompt first), the prepared tool definitions with their JSON
  schemas, the response messages, usage, model latency, and provider metadata
  (AI Gateway cost included). Child-process workers ship their records over the
  worker channel and the runner writes one file at the end, ordered by time. The
  trace is the model's view only: observations reach it already redacted, and
  image evidence is recorded by byte size, never by pixels.

  `RunOptions.aiTrace` and `RunOutcome.aiTracePath` expose the same for the
  programmatic runner; `e2e init` ignores the new file.

- [#111](https://github.com/tester-army/e2e/pull/111) [`6e514c0`](https://github.com/tester-army/e2e/commit/6e514c0ce266875921552912f1f304332b408f5a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `ArtifactStore`: the cloud seam for evidence, the way `TraceCacheStore` is for
  traces. `artifacts` accepts `{ kinds, store }`; a host-supplied store receives
  every artifact the moment it is complete on disk — bytes, digest, and report
  identity — not after the run, and returns its own reference, recorded on the
  artifact as `ref` beside the local path. A failed `put` never fails the run;
  the record simply carries no `ref`. Without a store nothing changes. The
  report schema gains the optional `artifact.ref` (`suiteVersion` 0.8.0 → 0.9.0).

- [#98](https://github.com/tester-army/e2e/pull/98) [`0ae44ef`](https://github.com/tester-army/e2e/commit/0ae44ef9137e3a78b6164f4f9a6fa7114290b9ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The backend contract (RFC0002): `@e2edev/e2e/backend` ships `defineBackend`, and
  targets accept `{ name, platform, backend }` with no driver — no browser is
  resolved or launched, and `app.url` becomes optional when every target is a
  backend target. A backend declares its capabilities: `observe()`
  unlocks the judgment tier and agent observation, and `actions` (the closed
  verb set) unlocks harness-routed grammar actions. Undeclared capabilities fail loud with
  `UNSUPPORTED_CAPABILITY`, never silently. Backends get `init`/`dispose`
  lifecycle hooks bounded by the launch and cleanup timeouts.

  `agent` config now accepts an executor alongside the options:
  `agent: { executor, model, maxModelCalls, context }` — a custom brain no
  longer forfeits the model, budgets, or project context.

- [#99](https://github.com/tester-army/e2e/pull/99) [`09f5f24`](https://github.com/tester-army/e2e/commit/09f5f24dba0d82b5fe5d7a09a7bac293083dd738) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Backends can carry platform-neutral **state** (RFC0002 step 2', part 1):
  `defineBackend({ state: { capture, restore } })` where the snapshot is opaque
  JSON the harness never inspects. Session save/restore (`test.setup` +
  `session:` option) now works on backend targets through this capability,
  exactly as it does for drivers — a browser's storage state, a device's app
  state, and a desktop's window state satisfy it identically. Nothing
  web-shaped enters the contract. Artifacts land with the playwright backend,
  where the real evidence-writing story lives.

- [#114](https://github.com/tester-army/e2e/pull/114) [`e19b826`](https://github.com/tester-army/e2e/commit/e19b826a7f2a944122099851803f6961f107cf86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/playwright` and `@e2edev/agent-device`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Driver action events carry `detail`: bounded, redacted prose for what the
  action did — `tap button "Approve"`, `fill secret "password" into textbox
"Password"` — with the same wording as recorded trace summaries, so a live
  reporter or an embedding host can render each act without a side lookup.
  Secret values never appear; the secret's stable name stands in.
  `report-v1.schema.json` gains the optional `event.detail` field
  (`suiteVersion` 0.6.0 → 0.7.0).

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The programmatic host surface lands as `@e2edev/e2e/run`. `run()` executes one
  complete run in-process — no `process.exit`, external `AbortSignal`
  cancellation, the full report-1 document returned in memory — and the new
  `onEvent` option streams every lifecycle fact (`run-started`, `plan`,
  `test-started`, per-step `start`/`end`/child events, `test-finished`,
  `serial-group`, `run-error`, `run-finished`) as plain JSON data with an
  emitter-stamped `seq`. A sink that throws is quarantined for the rest of the
  run instead of affecting it. The CLI is a thin consumer of exactly this
  surface; `report.json` stays the canonical record. Cancellation is honored from the first moment of the run — app startup and collection, not only once the scheduler is live — and a failure during teardown (session store, app process) now reaches the exit code instead of being recorded and dropped.

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Two hosted-cache seams. A host-supplied `cache.store` is now exempt from the
  CI read-only clamp: the clamp exists because committed file caches are
  untrusted input, and a remote store a host operates is neither committed nor
  untrusted — it states its own trust through `writable`. And the new
  `app.identity` config keys cache and session identity by a stable logical app
  identity instead of the base URL's origin, so ephemeral per-deploy origins
  (PR previews) share their recorded traces; the environment always joins the
  derived identity, so an identity never bleeds entries across environments.

- [#101](https://github.com/tester-army/e2e/pull/101) [`8c97039`](https://github.com/tester-army/e2e/commit/8c9703906c476af6dea063c44ddc179399b102e5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - **Breaking.** Playwright is a backend, and core knows no platform (RFC0002
  step 2'). The bumps stay `minor` under the 0.x policy, but the shapes below
  are removed or changed and a project upgrading must migrate its config and any
  backend it wrote.

  Removed:

  - `@e2edev/e2e/driver`, `defineDriver`, and every driver-SPI type; the `driver:` and
    `browser:` target keys; the top-level `browser` config key; the implicit
    zero-config web target. `targets` is required and a target is
    `{ name, platform, backend? }`.
  - The `actions` verb object on a backend (`actions: { tap, type, press,
select, scroll, navigate, back }`). Every node action is now
    `perform(ref, action, context)` taking one `LocatorAction`; viewport scroll
    is `swipe(direction, momentum, context)`; `navigate` and `back` live under
    `app: { navigate?, back?, restart?, clearState? }`. The `actions` capability
    means `perform` is declared, and the agent offers the model only the verbs
    the backend declares.
  - `artifacts: ['video']` is no longer accepted in config, and `video` is gone
    from the report's `artifactCapabilities` (a fixture may still attach a
    `video` artifact).
  - `DRIVER_FAILURE` is now `BACKEND_FAILURE`.

  Changed:

  - `Backend.version` is required (a non-empty string): it is provenance and
    keys the trace cache.
  - `endAttempt(context)` and `dispose(context)` receive a
    `BackendCleanupContext` (`{ signal, timeoutMs }`) whose `signal` aborts when
    the cleanup budget is spent. `dispose` runs whether or not `init` ran, and
    `init` may run again after `dispose` on the same handle.
  - `defineBackend` validates the nested `state`, `artifacts`, and `app`
    manifests (closed keys, function members), binds every method so a class
    instance is a valid body, and rejects unknown nested keys with
    `INVALID_CONFIG`.
  - `BackendInitInfo.app.baseUrl` and `BackendFixtureContext.app.baseUrl` are
    optional; absent when no app URL is configured.
  - `Web`, `WebRoute`, `WebResponse`, `RouteFulfillResponse`, `Cookie`,
    `Dialog`, and `WebExpectation` moved out of `e2e` into `@e2edev/playwright`.
    `expect(fixture)` routes to whatever expectation surface a backend attaches
    through `BackendFixtureContext.expectable`. Every `web` method call,
    including `url()`, `title()`, and `cookies()`, is now a recorded step.
  - Reports and session envelopes record `backend: { name, version, spiVersion }`
    instead of `driver`, drop `browser`/`browserVersion`/`viewport` from target
    provenance, and step events use kind `backend` (spec `suiteVersion` 0.6.0).

  Added:

  - `@e2edev/playwright` exports `playwright(options)`: a `defineBackend` handle
    with observation, actions, location, state, artifacts, and the contributed
    `web` fixture. `browser` and `viewport` are its options. It also exports
    `test` typed with `web`; `expect` and `credentials` still come from `e2e`.
  - `@e2edev/e2e/backend` exports `BACKEND_ERROR_CODES` and
    `RETRYABLE_BACKEND_ERROR_CODES` (`NODE_STALE`, `FRAME_NOT_FOUND`).
  - `@e2edev/e2e/backend` exports the semantics the spec requires every backend to
    reproduce exactly: `TestError`, `ConfigurationError`, `InfrastructureError`,
    `matchesText`, `toTextPattern`, `describePattern`, `urlMatches`,
    `pollCondition`, `Deadline`, and `validateJsonValue`. The `@e2edev/e2e/internal`
    subpath is removed; a backend package depends on `@e2edev/e2e/backend` only.
  - `defineTool` accepts `platforms` to scope a tool pack to targets by
    platform, and `StepExecutorContext.target` names the target a step runs on.

  Migration:

  ```ts
  // before
  export default defineConfig({
    browser: "chromium",
    targets: [{ name: "web", platform: "web", driver: "playwright" }],
  });

  // after
  import { playwright } from "@e2edev/playwright";

  export default defineConfig({
    targets: [
      {
        name: "web",
        platform: "web",
        backend: playwright({ browser: "chromium" }),
      },
    ],
  });
  ```

  A backend written against the earlier `@e2edev/e2e/backend` draft moves its `actions`
  verbs onto `perform` (switch on `action.kind`), its viewport `scroll` onto
  `swipe`, its `navigate`/`back` under `app`, declares `version`, and accepts
  the cleanup context on `endAttempt`/`dispose`.

- [#20](https://github.com/tester-army/e2e/pull/20) [`1e21658`](https://github.com/tester-army/e2e/commit/1e21658c949900be0191221a468647e43b6ddf2a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move the Playwright driver into its own `@e2edev/playwright` package.

  `e2e` no longer depends on `playwright`, so installs that drive another backend
  no longer download a browser. `driver: 'playwright'` still works and is still
  the default for web targets; the runner now loads the driver from
  `@e2edev/playwright`, which it declares as an optional peer dependency.

  **Upgrading:** install the driver alongside the runner.

  ```bash
  npm install --save-dev @e2edev/e2e @e2edev/playwright
  ```

  A target that names the driver without the package installed now fails config
  resolution with `DRIVER_NOT_INSTALLED` and exit code 2, naming the package to
  install.

  Also in this release:

  - Drivers can implement an optional `prepare` hook, run once before any session
    launches, for slow one-time provisioning. Browser downloads now happen there,
    so they are never charged against a launch timeout for any driver, not just
    the built-in one. A failing `prepare` aborts the run as an infrastructure
    error instead of a test failure.
  - The list reporter now prints run-level errors. Previously a run that failed
    during config, collection, or provisioning exited non-zero with the reason
    only in `report.json`.
  - The `e2e/playwright` subpath export is removed; import from
    `@e2edev/playwright` instead.

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Fill-time secret providers. A credential's `password` may now be a
  `SecretProvider` function instead of a string: it is called on every
  authorized fill and resolves the plaintext at fill time — a vault lookup, a
  freshly computed TOTP. The resolved value goes straight to the trusted
  driver, joins runner-side redaction the moment it exists, and is never
  logged, cached, or sent to a model. An `E2E_USER_*` environment override wins
  over a provider; like executors and custom stores, a provider never crosses a
  process boundary. An empty static password — including an empty `E2E_USER_*`
  override — is now a configuration error at load, not a fill-time failure.

- [#89](https://github.com/tester-army/e2e/pull/89) [`b97e065`](https://github.com/tester-army/e2e/commit/b97e065d215e7a299ae7da07176e7c57c702ad21) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter narrates agent runs live. While a test runs, the status
  block shows the active step with an animated spinner and its latest model
  turns and tool calls; each finished agent step collapses to one permanent
  line with its duration and model-call count. Test result lines and the run
  summary report model usage: total tokens and, when the provider bills
  per request (AI Gateway), real cost in USD.

  Executors can now report per-call cost via `ExecutorModelCall.estimatedCostUsd`;
  the built-in tool-loop reads the AI Gateway's per-request cost automatically,
  so `--debug` step tables and `report.json` model provenance carry `estimatedCostUsd`.

- [#92](https://github.com/tester-army/e2e/pull/92) [`6a64197`](https://github.com/tester-army/e2e/commit/6a64197e17a288bfe06b3f6f6e79297f836db686) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The adaptive trace cache (`trace-1`) lands. Each passing `agent.act()` step
  records the grammar actions it performed — durable target descriptors,
  secret-free inputs, gap markers for project-tool mutations — and the next run
  replays them zero-turn through the same policed grammar. A full replay
  self-finalizes the step as passed with zero model calls; any divergence hands
  the step to the executor mid-step with a `replayedPrefix` notice and the step
  re-records on pass. Judgments are never cached.

  A replay never passes on mechanics alone: each entry records the state the
  step passed in — the end path and the **end anchors**, the elements that
  appeared between the step's first observation and its passing one — and a
  full replay self-finalizes only while that state is on screen again. A flow
  whose actions all ran but whose effect is missing hands off with
  `end-mismatch`, and the built-in agent is told to verify before acting. If the
  agent then has to act further to pass, the entry is evicted rather than
  re-staged with the failed flow plus its repair; a hand-off the agent settles
  without acting heals the anchors in place.

  New surface:

  - config `cache`: `'off' | 'read-only' | 'read-write'` or
    `{ mode, store, dir }`. **Opt-out**: unset means `read-write`; CI forces
    read-write down to read-only; `e2e run --no-cache` overrides the config
    for one run. `store` accepts any `TraceCacheStore` implementation, so a
    shared remote cache can replace the default `.e2e/cache/` file store.
  - `StepExecutorContext.replayedPrefix` (`ReplayedPrefix`,
    `ReplayHandOffReason`): the mid-step hand-off contract for executors.
  - Report: agent steps carry `step.cache`
    (`self-finalized | agent-concluded | missed` + a closed reason token).
  - Write settlement is attempt-scoped: passing steps stage their traces,
    confirmation requires a later passing **verification step** (an `expect`
    assertion, a locator `waitFor`, `agent.assert`, or `agent.waitFor`) — a
    later `agent.act` or the attempt passing on its own confirms nothing — an
    unconfirmed entry is evicted, and interruption touches nothing.
  - Exported types: `CacheMode`, `CacheConfig`, `TraceCacheStore`,
    `CacheReadResult`, `ActionTrace`, `RecordedAction`, `TraceEntry`,
    `TraceTargetDescriptor`.

  Spec: 10-determinism's "No caching" clause is replaced by the trace cache
  chapter; 05-config and 16-executors document the config key and the hand-off;
  `report-v1.schema.json` gains `step.cache`; conformance `suiteVersion` bumps
  to 0.8.0 with the `trace-1` profile, including `TRACE-ANCHOR-001` and the
  verification-step write rule.

- [#78](https://github.com/tester-army/e2e/pull/78) [`61b31dd`](https://github.com/tester-army/e2e/commit/61b31dd95e431804e5bdb17a37da325d4dca10ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Locate nodes that no query can name, and observe shadow roots and `data:` frames.

  An agent step whose target has no accessible name, test id, placeholder, or text
  used to fail with `LOCATOR_NOT_FOUND` before it looked at the page. The model had
  already selected the right node; the runner discarded it because no portable
  query could be derived from it — so the agent tier failed hardest on exactly the
  controls that have no deterministic address either, such as an input whose label
  is the table cell beside it.

  The locate sweep now falls through to the two paths that need no query:

  - the node's **observed reference**, which the driver backs with the element
    itself, and
  - the driver's **platform selector** for the node when it has an anchored one, in
    which case the located node carries a real locator instead of a reference and
    so survives into the cache and into `dragTo`. Recorded as the
    `locate.selector` policy decision.

  Both paths re-read the live node and require its recorded identity before acting,
  exactly as replay does, so a stale selection is still a miss rather than a blind
  dispatch. `poll: false` callers keep their early exit for escalation.

  One observation gap closes alongside it in `@e2edev/playwright`: **open shadow
  roots are walked**, so a control that exists only in a shadow tree is now
  selectable. Slotted content is not double-counted — slotted elements are
  light-DOM children, and the shadow tree holds `<slot>` placeholders rather than
  copies. A closed root stays invisible, as it is to a person reading the page.

  Empty painted rectangles are observed, and a drag can end on one.

  A drop zone, a colour swatch, a chart placeholder: an element defined by being
  empty carries no role, name, text, or test id, so the observation walk skipped it
  and no instruction could name it. An empty element that paints something — a
  border, an outline, a background of its own — and is at least 12 CSS pixels on
  each side is now reported with the role `box`. Nothing else changes: an unpainted
  spacer of the same size is still omitted, because a person cannot see it either.

  `dragTo` also no longer requires a locator on both sides. `Locator.dragTo` takes
  two locators, so a destination the agent reached through its observed reference
  made the whole verb unavailable — exactly for the elements that have no locator.
  When either endpoint is reference-backed the driver drives the pointer instead,
  which is also what makes HTML5 drag-and-drop commit, since it needs a real
  `dragover`. A drag whose _source_ is reference-only still fails: `dragTo` locates
  twice and every observation disposes the generation before it, so the source
  handle does not survive to the dispatch. That is an observation lifecycle
  question, not a drag one.

### Patch Changes

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Agent step fixes and prompt savings:

  - The wind-down window that forces `complete_step` scales with the step
    budget (a quarter of it, capped at 60 s) instead of a flat 60 s that took
    half of a default 120 s step.
  - A project tool (`defineTool`) that throws an ordinary error now returns the
    failure to the model as text, like a grammar action, instead of failing the
    step as `MODEL_PROVIDER_FAILED`. A mutating project tool is refused before it
    runs once the action budget is spent, and a failed call consumes its slot.
  - An executor that brings its own model no longer triggers resolution of the
    configured `agent.model`, so a missing credential for an unused model cannot
    fail the run.
  - The initial screen tree in the step prompt is compacted like later
    snapshots once newer observations exist; step params are serialized
    compactly. `agent.waitFor` no longer takes five throwaway observations per
    judgment interval.
  - Late model or tool accounting from an executor abandoned by a hard stop can
    no longer land on the following step. Step transcripts pass the secret
    redactor before they are written.

- [#77](https://github.com/tester-army/e2e/pull/77) [`9646852`](https://github.com/tester-army/e2e/commit/9646852104033c826faaeabfa4a2e334477a9f3f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Write the spec-mandated `A256GCM` algorithm name in session envelopes.

  Envelopes carried the Node cipher name `aes-256-gcm`, which the frozen
  `session-v1` schema rejects (`SESSION-SCHEMA-001`). The encryption itself is
  unchanged — still AES-256-GCM — only the wire literal is corrected. Envelopes
  written by an earlier version are not readable by this one; sessions are
  per-run, so nothing persists across runs.

  Produced envelopes are now Ajv-validated against
  `spec/schema/session-v1.schema.json` in the test suite, so this drift cannot
  recur silently.

- [#79](https://github.com/tester-army/e2e/pull/79) [`bc0f377`](https://github.com/tester-army/e2e/commit/bc0f377a0a2b5c9e9cea5cfffbcf94a1e8dcd7ae) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Harden the boundary between the runner and an out-of-tree driver.

  A driver's `DriverError` is now recognized structurally rather than with
  `instanceof`. A driver imported by a config file resolves through a different
  module registry than the runner, so the two hold different copies of the class
  and `instanceof` misses. Every typed driver failure then lost its taxonomy: a
  retryable `NODE_STALE` stopped being retried and surfaced as a generic failure
  instead of a recoverable race. This affects any driver package, including
  `@e2edev/playwright` whenever a project ends up with more than one copy of
  `e2e` resolved.

  Builds now clear `dist` before compiling. `tsc` only writes files, so output
  whose source has since moved or been deleted survived every later build and was
  published: after the Playwright driver moved out of `e2e`, the `e2e` tarball
  still carried a full copy of the old `dist/playwright` tree.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Correctness and speed fixes across the runner's support layers:

  - `agent.act` params and `web.evaluate` values that reach the same object by
    two paths are no longer rejected as cycles.
  - A setup test filtered out by its own `platforms` list can no longer be
    promoted to run on a target it excluded; a consumer that needs it is a
    collection error, as for a missing capability.
  - Trace start and end paths pass the secret redactor before they are written;
    a redacted path marks the trace non-replayable. The start-path precondition
    now compares by pathname like the end postcondition, so a differing query
    string no longer cold-misses the cache.
  - Negated assertions with a budget shorter than the one-second grace window
    can pass again; `toHaveCount` polls within its assertion deadline.
  - Replay relocation projects each observed node once per observation instead
    of once per recorded action per tier; wire regexps are compiled once; text
    sanitizing and UTF-8 truncation are single-pass; value matchers format
    failure messages only on failure; test discovery skips dot-directories.
  - Dead code removed: the unused `internal/backend-text` module, the unused
    `selectorExpression`, and several exports that had no consumer.

- [#74](https://github.com/tester-army/e2e/pull/74) [`9334e8f`](https://github.com/tester-army/e2e/commit/9334e8f35cbaacbe61b10b3489ea87a920aeb99a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Ship package metadata for the registry: repository, homepage, bug tracker,
  keywords, and the MIT `LICENSE` file. Releases publish under the `beta`
  dist-tag while the surface stabilizes, so `latest` is not moved.

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A failed canonical-report write is an infrastructure run error
  (`REPORT_WRITE_FAILED`), not a footnote: it joins the exit code (3) and the
  run status, the returned in-memory report carries it, and `reportPath` — on
  the outcome and the `run-finished` event — is present only when the file was
  actually written. Previously a run whose report could not be written still
  returned success and a path to a missing file.

- [#93](https://github.com/tester-army/e2e/pull/93) [`797fa6d`](https://github.com/tester-army/e2e/commit/797fa6d695b644de4e882c7b215418d580c7b19e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Executor-facing observations always settle. Every `observe()` an executor
  makes re-observes until the page shape holds still (75 ms poll, 1 s ceiling —
  one shared loop with replay's pre-action wait), so the executor never reads a
  snapshot the app is still reacting to. Before this, a fetch-backed mutation
  could hand a fast model a pre-render observation: the model would repeat the
  action — double-toggling the state it had just set — and then judge the step
  on equally stale evidence, reporting a pass the deterministic assertion after
  it correctly failed. Observed live on the bench (`gemini-3-flash`, the
  approve-expense flow) and fixed by this settle. Replay still reads raw
  observations and does its own settling through the same shared loop.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - CLI, config, and report correctness:

  - Usage errors (unknown flag or command, malformed value) exit 2 as the spec
    reserves for CLI errors; `--help` and `--version` exit 0. Previously commander
    exited 1, which CI reads as a test failure.
  - `--workers` and `--retries` obey the same bounds as the config keys they
    replace; `--workers 0` no longer plans work no worker can take.
  - A live `agent.visionModel` instance is reduced to its identity before the
    config digest, like `agent.model`, so provider settings never enter the
    digest and workers agree on it.
  - A non-array `targets` is an `INVALID_CONFIG` error instead of a crash.
  - `run.status` can be `blocked` when the only failures are serial-group
    members blocked by the agent's budget or environment.
  - `defineBackend` binds fixture factories like every other member, so a
    class-based backend keeps `this` in its fixtures.
  - Test files and the config are loaded through one registered TypeScript
    loader instead of registering a new loader hook per import; large suites no
    longer slow down as they collect.
  - The list reporter's live block stops repainting once the run has ended.

- [#107](https://github.com/tester-army/e2e/pull/107) [`e0ac8af`](https://github.com/tester-army/e2e/commit/e0ac8af5ca2247eef0962945b7500efede1bbb8d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Runner lifecycle fixes and speedups:

  - `afterAll` now runs for a realm a failing or timed-out test discards, and
    before a serial group takes over a file; previously suite teardown was
    skipped on every failure and retry.
  - Serial groups and setup tests now run `beforeAll`/`afterAll` for their
    scopes like ordinary tests. A `beforeAll` failure inside a serial group
    skips its members as `hook-failed` and fails the group without retrying.
  - A test whose retry hits a `beforeAll` failure keeps its recorded attempts
    and reports `failed`, not `skipped`.
  - A worker that cannot re-import a unit's module no longer drops that unit's
    tests from the report; they are recorded as infrastructure failures.
  - Ctrl-C during app start or collection now stops the app process group and
    removes the session directory; the readiness probe is bounded and backs off
    instead of polling every 250 ms.
  - Each worker imports a unit's test file once instead of twice; session states
    are decrypted once per worker; artifact hashing runs off the event loop.

- [#75](https://github.com/tester-army/e2e/pull/75) [`a1b80dc`](https://github.com/tester-army/e2e/commit/a1b80dc1ff43589539181cb50a1fdf6cc254b9e7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Harden agent model calls against transient provider failures.

  Transport retries per model call go from 2 to 5. Only failures the provider
  marked retryable are retried, `retry-after` is honored, and the remaining step
  timeout still bounds the whole chain, so a healthy provider is unaffected while
  a rate-limited or briefly 5xx-ing one no longer fails the step.

  An exhausted retry chain now reports the provider failure that actually
  occurred in `MODEL_PROVIDER_FAILED` instead of the SDK's retry wrapper, and a
  chain cut short by the deadline still classifies as `STEP_TIMEOUT`.

- [#97](https://github.com/tester-army/e2e/pull/97) [`1f98654`](https://github.com/tester-army/e2e/commit/1f9865476924a93bfc70cdebe144a3e8e7c92f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `buildTraceEntry` and `readTraceEntry` are exported for custom
  `TraceCacheStore` implementations: a remote store (Redis, an API) serializes
  `buildTraceEntry(payload)` on write and validates read documents with
  `readTraceEntry` — the same trace-1 framing the default file store uses, so
  a remote entry can never be trusted more loosely than a local one.
