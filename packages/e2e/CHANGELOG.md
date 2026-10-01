# e2e

## 0.15.1

### Patch Changes

- [#706](https://github.com/tester-army/e2e/pull/706) [`1a80c23`](https://github.com/tester-army/e2e/commit/1a80c23d8789382847aa78fb5325ecc1281c3b6a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - npm package pages: `e2e` ships the repository README, and every package has keywords people search for.

- [#709](https://github.com/tester-army/e2e/pull/709) [`9f62d9b`](https://github.com/tester-army/e2e/commit/9f62d9bdce82c5b705ecba6d51076fb89f37eb63) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The bundled skill (`e2e init`, `e2e guide`) shows the current config shape: its first `e2e.config.ts` and the setup example declare the app on the target, `targets: [{ engine: web(), app: { url, command } }]`, instead of the removed `web({ url, command })`, which fails at config load with `INVALID_CONFIG`. The `running` topic no longer mentions service processes, which this version does not start.

## 0.15.0

### Minor Changes

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the web engine's fixture is `browser`, not `web`: `test('...', async ({ screen, browser }) => { await browser.goto('/') })`, `expect(browser).toHaveURL('/')`, and `requires: ['browser']`. The `Web` type is now `Browser` and `WebExpectation` is `BrowserExpectation`; the `web()` engine factory and the network and option types (`WebRoute`, `WebResponse`, `WebOptions`) keep their names. Recorded steps read `browser.goto` and the rest. A leftover `requires: ['web']` skips the test on every web target: rename it to `requires: ['browser']`.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: credentials and secrets are separate namespaces. `secrets.get(name)` returns `config.secrets` entries only and no longer a credential's password, which is `credentials.user(name).password`; the error for a credential's name says so. A credential's password handle is named `<name>.password` (`admin.password`), which is what the agent, `<secret:...>` redaction markers, `e2e mcp`, and the replay cache see, so a credential and a secret may now share a name. A `secrets.get()` in an engine option must name a `config.secrets` entry. Replay cache entries that filled a credential's password miss once and re-record. An entry recorded on a screen that showed the password (redacted `<secret:admin>`, now `<secret:admin.password>`) keeps its key but no longer relocates its target; re-record it, which under `--strict-cache` is the `REPLAY_STALE` it fails with.

- [#678](https://github.com/tester-army/e2e/pull/678) [`f575e5d`](https://github.com/tester-army/e2e/commit/f575e5dec71227c1e6ef9b2ce6d63f23015d3751) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e feedback` sends a bug report, docs problem, or feature request to the e2e team: `e2e feedback --type bug -m "..."`, with optional `--task`, `--expected`, `--actual`, `--approach`, `--command`, and `--agent`. The report goes to PostHog as one event with the anonymous machine facts telemetry carries; secret-named environment variable values and well-known token shapes are redacted first, and `--dry-run` prints the event without sending it. A saved `e2e telemetry disable` does not stop it; `E2E_TELEMETRY_DISABLED` and `DO_NOT_TRACK` do, with exit 2. The skill tells coding agents when to use it. `e2e telemetry` now says "No usage data is sent from this machine." when telemetry is off.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByRole` takes the accessible name as its second argument: `screen.getByRole('button', 'Sign in')`, a string or a `RegExp`, with the other options after it (`getByRole('button', 'save', { exact: false })`). The object form, `getByRole('button', { name: 'Sign in' })`, still works. The `e2e mcp` `locate` tool writes the short form.

- [#698](https://github.com/tester-army/e2e/pull/698) [`4d488f8`](https://github.com/tester-army/e2e/commit/4d488f828695998275590e5da9aa5be77b8cf726) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the app under test is declared on its target, in `targets: [{ engine, app }]`, and nowhere else. `app` takes `url`, `bundleId`, `appPath`, `identity`, `environment`, `launchArguments`, `permissions`, `command`, and `readyUrl`. The old spellings (`web({ url })`, `mobile({ app })`, an app key directly on the target, a top-level `app`) are unknown keys and fail at config load with `INVALID_CONFIG`. `services` is gone for now, an unknown key wherever it appears: this version starts no dependency process beside `app.command`, and a services API returns in a later release. A port-0 `app.url` with no `app.command` to serve it, and `reuseExisting` on an app whose `app.url` asks for a free port, are `INVALID_CONFIG` too; the command takes the assigned port through `{port}` in its `args` or `env`. Replay cache and session identity are unchanged, so recordings made with the app on the engine still replay.
  
  The engine contract follows: `defineEngine({ app })` is gone. An engine checks the target's app for what its platform needs in the new synchronous `validateApp(app, { targetName })`, and `prepare` and `init` receive the resolved app as `info.app` (`EngineAppInfo`: the site, plus `bundleId`, `appPath`, `launchArguments`, and `permissions` for a device). `EngineAppDeclaration` is now `EngineAppInfo` plus the declared `url`; `CommandConfig` is no longer exported from `e2e/engine`, and `ServiceConfig` is gone. A test can `requires: ['browser']` for a target with an `app.url` or `requires: ['native-app']` for one with an `app.bundleId` or `app.appPath`.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect(value).toMatchSchema(schema)` validates a value against a synchronous Standard Schema (Zod, Valibot, ArkType) and returns the schema's output, typed: `const users = expect(await response.json()).toMatchSchema(z.array(User))`. A failure lists every issue by its path. `expect.poll(read).toMatchSchema(schema)` resolves to the output of the passing read, and `expect.soft(value).toMatchSchema(schema)` returns `undefined` after a kept failure. A schema that validates asynchronously is `INVALID_ARGUMENT`.

- [#704](https://github.com/tester-army/e2e/pull/704) [`3dc4ec9`](https://github.com/tester-army/e2e/commit/3dc4ec96146357ab164b1bcf7add275002d805ef) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `describe`, `beforeEach`, `afterEach`, `beforeAll`, and `afterAll` are top-level exports of `e2e`, the same functions as `test.describe` and the `test.*` hooks: `import { describe, beforeEach, test } from 'e2e'`. `@e2e-dev/web` and `@e2e-dev/mobile` export `describe` and all four hooks beside `test`, typed with their `browser` or `device` fixture, so a test file registers from one import. `test.describe` and the `test.*` hooks stay, and are how a `test.extend()` chain registers hooks that see its fixtures.

### Patch Changes

- [#666](https://github.com/tester-army/e2e/pull/666) [`3842b90`](https://github.com/tester-army/e2e/commit/3842b908ced383e539b614fd54ec06687af25ee7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A model request that gets no response within 120 seconds is aborted and sent again through the transport retries, for `agent.act` turns and the judgments alike, and an `agent.act` step notes it in its `--debug` transcript and, from the second turn on, on the report turn before it (`[loop] turn 2 got no response in 120s: sending it again`). The bound covers the whole request, not only its first byte, so one answer that takes longer than 120 seconds is sent again too. Before, one stalled request held the step until its own timeout: an `e2e explore` step spent 220 of its 240 seconds waiting on a single call. A step the clock ends now keeps the turns that ran in the report and in the `--debug` transcript; before, a `STEP_TIMEOUT` step had none. A turn's loop notes (a resent request, a shrunk history, a forced tool choice refused) are kept in the report after the clipped tool results instead of being clipped off with them.

- [#655](https://github.com/tester-army/e2e/pull/655) [`8904b02`](https://github.com/tester-army/e2e/commit/8904b02ab57db2050e932e20525a62d9a9fbf839) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The JSDoc of the agent call options names the current defaults: `assert`, `waitFor`, and `extract` default to the agent's `judgmentTimeout`, `act` to `config.timeout`, and the budgets to `agents.<name>.maxSteps` and `agents.<name>.maxModelCalls`. `CacheMode` says CI demotes only an unset mode without a custom store to `read-only`. The `agent` fixture's JSDoc says only the built-in agent needs a model to be acquired.

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Agents config follow-ups. A missing model names the agent the run selected (`agents.ux has none: ... agents: { ux: { model: ... } }`) instead of always `agents.default`, and `e2e explore` fails with `MODEL_UNAVAILABLE` before anything starts when the explored agent has no model, a custom executor that brought none included. Its custom-executor notice names the agent key. A model instance used as an agents entry says to write `{ model }` instead of reporting `specificationVersion` as an unknown key. A mistyped agent on a call (`agent.act('x', { agent: 'buyr' })`) suggests the nearest configured one. A project tool named `locate`, `start_recording`, `stop_recording`, or `report_finding` fails at config load instead of being dropped in `e2e mcp` or replaced under `explore`. The config digest names tools and reduces executors and `cache.store` to their identity instead of JSON-cloning them, so a recursive zod tool schema or a store holding a client no longer crashes the load with "Converting circular structure to JSON".

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The bundled skill's bug-bash reference gives each charter its own `--output .e2e/bugbash/<slug>` instead of the removed `--artifacts`.

- [#668](https://github.com/tester-army/e2e/pull/668) [`a53472c`](https://github.com/tester-army/e2e/commit/a53472cc4293fb7d928997cea3d1fd1ecca8465c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A local read-write run no longer rewrites a committed recording whose flow is unchanged. Recordings compared equal only when the rule that flagged a typed run-time value (`derived`) matched too, and that rule follows how the agent read the value on that run (off pixels once, off a node the next), so entries in a committed `.e2e/cache` changed on every run.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A configuration error the config raises while it evaluates keeps its own code: an option `web()` or `mobile()` refuses, such as the renamed `web({ video })`, fails with `INVALID_CONFIG` and its message, as the docs say, instead of `CONFIG_LOAD_FAILED`. A failed import is still `CONFIG_LOAD_FAILED`.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Importing the removed `createAgent` from `e2e/agent` fails with a `CONFIG_LOAD_FAILED` that names the replacement, the options written as the agents entry itself (`agents: { default: { model, system, tools } }`), instead of the bare ESM missing-export error.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A Ctrl-C that reaches workers still loading, before they ignore the signal, no longer reports `WORKER_INIT_FAILED`; the run's interrupt skips the target's tests with the reason `run interrupted before execution` instead of `worker process failed to start`. A worker that dies of SIGINT, SIGTERM, or SIGHUP before it is ready is not a boot failure.

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A secret an engine option holds (`web({ basicAuth: { password: secrets.get(name) } })`) now has its text downloads rewritten through the redactor too, as its trace already was, and the web engine registers the base64 `user:password` credential of the `Authorization` header for redaction, so a page that echoes its request headers shows `Basic <secret:name>` in the report, `screen.txt`, the failure pages, the trace, what the model reads, and `e2e mcp` observations. The protection is text only: screenshots, the trace's screencast frames, and the model's pixels are kept as with no secret, so a page that renders the basic-auth password on screen is not masked in pixels. Engines pass such derived forms through the new `resolveSecret(secret, { derived })` option.

- [#668](https://github.com/tester-army/e2e/pull/668) [`a53472c`](https://github.com/tester-army/e2e/commit/a53472cc4293fb7d928997cea3d1fd1ecca8465c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agent.extract` no longer invents a value to fit the schema. The model receives the schema's shape without its value rules (`min`, `max`, lengths, patterns, formats), so a `z.number().min(100)` no longer pushes it to report 300 todos when the screen shows 3, and it can answer that the screen does not show the data: the step then fails with `ASSERTION_INCONCLUSIVE` naming what was missing, where it used to return `""` or `0`. Ask for absence explicitly (`'the phone, or null when none is shown'` with `.nullable()`) to get `null` back instead.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A failed agent action no longer reads as done. Its result leads with the tool, what it was aimed at, and the error code, `navigate file:///etc/passwd failed: POLICY_DENIED: forbidden URL scheme: file:`, instead of `Navigated to file:///etc/passwd. failed: ...`, for the testing agent's model and `e2e mcp` alike. Over MCP the result is now an error (`isError: true`), still carrying the screen the action re-observed.

- [#653](https://github.com/tester-army/e2e/pull/653) [`6b851bb`](https://github.com/tester-army/e2e/commit/6b851bb60484bd7a7cfe7e6edba1b7d2b1510b8c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` links the renamed "Commit the replay cache" section of the cache docs when it ignores `.e2e/cache/`.

- [#697](https://github.com/tester-army/e2e/pull/697) [`b5ac66d`](https://github.com/tester-army/e2e/commit/b5ac66d730507b7079e6dde4ae52b7c93e7f15ae) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - `e2e init` leaves a blank line between the wordmark and the `e2e init` header, so the wizard no longer sits flush against the word.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `--max-failures` no longer starts the next test in the file whose test reached the limit. The worker counts its own failures against the limit and skips the rest of its file with cause `failure-limit` at once, instead of starting the next test before the runner's interrupt arrives and reporting it `interrupted` as a second failure.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp` notices its client going away. A client that closes stdin, or dies and breaks the pipes, now closes every session, stops the app commands they started, and exits 0. Before, a session kept its browser and app running until SIGTERM or the idle timeout, a server with no session exited 13 with an unsettled top-level await warning, and a write to a dead client crashed with `EPIPE`, leaving the app running so the next session failed with `APP_ALREADY_RUNNING`.

- [#664](https://github.com/tester-army/e2e/pull/664) [`f67c49a`](https://github.com/tester-army/e2e/commit/f67c49a3556616fd55250a017de6673af8d8c0c1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp`: `open_session` on a config other than the one the open sessions use fails with `CONFIG_IN_USE` before the config evaluates. A config that hands an engine option `secrets.get()` of a secret only it declares no longer fails with a misleading `secret "..." is not configured` resolved against the open session's config.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An unknown permission name, a permissions value that is not a plain object, or a state other than `grant`, `deny`, or `reset`, fails before any device command: `app: { permissions: { camerra: 'grant' } }` on a mobile target is `INVALID_CONFIG` naming `camera`, and the same map in `device.openApp(app, { permissions })` is `INVALID_ARGUMENT`. Before, the typo reached agent-device on the first launch. `rejectUnknownKeys` in `e2e/engine` takes an optional `code`, `'INVALID_ARGUMENT'` for an object a test passes.

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `output` and `--output` are checked against the project root and `cache.dir` with symlinks resolved: `--output "$PWD/out"` in a checkout under a symlinked directory (`/tmp` on macOS) is accepted, and a `cache.dir` spelled through a symlink under `<output>/artifacts` is refused instead of deleted by every run. A symlink whose target does not exist yet is followed, so an `output` or `command.log` through one that points outside the project root is refused at load. An output that is a file, or under one, fails at load with `INVALID_CONFIG` instead of `REPORT_WRITE_FAILED` at the end of the run, and a refused default output is named `".e2e" (the default)`. The removed `--artifacts <dir>` suggests `--output .e2e` when its parent could not be an output.

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A run that stops before its tests start (`NO_TESTS` from a mistyped `--grep`, a collection error, `UNSUPPORTED_ARTIFACT`, `NO_LAST_RUN`, an app or service that fails to start, an interrupt) no longer clears `<output>/artifacts` or overwrites `<output>/report.json` and `<output>/ai-trace.json` (`output` defaults to `.e2e`): the previous run's evidence stays, and `--last-failed` still reads the last run that executed. The artifact tree is cleared once the app is up and tests are about to start.

- [#669](https://github.com/tester-army/e2e/pull/669) [`f5bc45a`](https://github.com/tester-army/e2e/commit/f5bc45ac145718ec82396f28339d479c48d66612) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The limits of a persistent browser context fail early and name their cause. `app.clearState()` with `kernel({ scope: 'attempt' })`, any provider with `scope: 'attempt'`, or `connect.reconnectEndpoint` fails with `UNSUPPORTED_CAPABILITY` naming that mode, instead of `engine web does not implement it`. A run whose tests consume a session on a target whose engine has no state capability fails with `COLLECTION_ERROR` before any test, instead of failing at `session.save()` after the setup test logged in.

- [#700](https://github.com/tester-army/e2e/pull/700) [`e020cf7`](https://github.com/tester-army/e2e/commit/e020cf7f140f4b5a2601cfe003ed081f8e6b94ce) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Once a secret has been filled in an attempt, `tap_at`, `hover_at`, `type_at`, `press_at`, and `select_at` answer with the `PIXEL_TAINTED` line instead of acting: the screenshot the model holds predates the fill and may no longer match the screen. Before, they kept aiming at that stale screenshot, while the MCP catalog and the docs said they would refuse. The bundled agent skill (`e2e guide`) is rewritten against the current runner: wrong claims fixed (reads fail at once on zero matches, negated matchers hold for one second, `clearState` has no serial-group limit, `onDialog` is async, `defineConfig` is `CONFIG_LOAD_FAILED`, blocked `act` codes, per-call budgets above the limit are `INVALID_ARGUMENT`), missing options and error codes added, migration notes and engine internals dropped, repeated facts reduced to one home each.

- [#662](https://github.com/tester-army/e2e/pull/662) [`10d392e`](https://github.com/tester-army/e2e/commit/10d392ea3ceb34c96ca1735812d60701c7830557) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Recording-mode messages say what to write. `artifacts: { kinds: [...], trace: { record: 'retries' } }` names `trace: 'on-all-retries'` instead of `'on'`, and the old trace spellings lifted to where a mode goes (`trace: 'retries'`, `trace: { record: 'retries' }`, `trace: 'all'`, `--trace retries`, `--trace all`) name the mode they meant. A retry `video` mode with `retries: 0` gets the same plan-time notice as `trace`, and under `e2e explore`, which runs once, the notice says to pass `--trace on` or `--video on` instead of setting retries. Removed-key messages read `specVersion was removed: delete it; ...`.

- [#668](https://github.com/tester-army/e2e/pull/668) [`a53472c`](https://github.com/tester-army/e2e/commit/a53472cc4293fb7d928997cea3d1fd1ecca8465c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `REPLAY_STALE` names what turned strict on and where the entry lives: `without --strict-cache`, `with cache.strict set to false`, or both, and the configured `cache.dir` relative to the project (or the configured `cache.store`). It used to say `without --strict-cache` and `.e2e/cache` whatever the config set.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `secrets.get()` reference turned into a string while `e2e.config.ts` evaluates (a template literal, `String()`, `+`, `JSON.stringify`) fails with `INVALID_CONFIG` explaining that only an engine option that declares secrets accepts one. Before, `agents.default.context: 'key ' + secrets.get('API_KEY')` held `[object Object]`. An `app.command` `args` entry or `env` value that is not a string, a number included, is `INVALID_CONFIG` too, naming a `secrets.get()` handle as one: `env: { API_KEY: secrets.get('API_KEY') }` started the app with `API_KEY=[object Object]`. An `env` value that is `undefined` (`process.env.KEY` unset) is dropped, as `spawn` drops it.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `tests` entry with no wildcard that names a directory is `INVALID_GLOB` naming the glob to write: `'!tests/wip'` excluded nothing (a glob names files), so write `'!tests/wip/**'`, and an including `'tests'` selected nothing. A file passed to `e2e run` that a `!` entry excludes is `NO_TESTS` naming that entry, instead of offering another file as the one meant.

- [#663](https://github.com/tester-army/e2e/pull/663) [`27e118d`](https://github.com/tester-army/e2e/commit/27e118dd9cc40400e02816a42718295159fba6c8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A trace of an attempt whose engine holds a secret (`web({ basicAuth: { password: secrets.get(name) } })`) no longer keeps the password base64-encoded in the `Authorization: Basic` header of every request after the challenge. Trace redaction now decodes each base64 and base64url run and replaces a run that holds a secret, or 8 or more characters of one, with its `<secret:name>` marker, so cookies and token segments that encode a secret are covered too. Before, the report labelled such a trace `redaction: "complete"`.

- [#668](https://github.com/tester-army/e2e/pull/668) [`a53472c`](https://github.com/tester-army/e2e/commit/a53472cc4293fb7d928997cea3d1fd1ecca8465c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An action that leaves the semantic tree unchanged no longer tells the agent the control had no visible effect unless an identical screenshot says so too. With no screenshot to compare, the result says no listed node changed and that a drawn change needs a screenshot to see. On a PIN pad whose taps only fill drawn dots, the agent used to abandon working taps for pixel taps: 13 to 14 model calls and 46 to 55 s for four digits, now 7 to 11 calls and 21 to 36 s.

- [#670](https://github.com/tester-army/e2e/pull/670) [`0073644`](https://github.com/tester-army/e2e/commit/0073644863ef95fa264ee5e0d1ca63d3c86d5da9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Unknown keys are rejected below the top level of the config too, naming the nearest known key when one is a plausible typo and the known keys otherwise. `app: { url, comand }` on a target is `INVALID_CONFIG` (the run used to go on and fail with `APP_UNREACHABLE`), and so are an unknown `web()` or `mobile()` option, an unknown key inside `connect` or `basicAuth`, and an unknown key in `app.command` (`command: { executable, arg }` dropped the arguments). An unknown test or `describe` option (`{ timout }`) is `COLLECTION_ERROR`, and an unknown query option (`getByRole('link', { nam })`) is `INVALID_LOCATOR` listing the keys the query takes. `e2e/engine` exports `rejectUnknownKeys(label, value, keys)`, the same check for an engine's own options.

## 0.15.0-canary-20260929180659

### Minor Changes

- [#646](https://github.com/tester-army/e2e/pull/646) [`d228e22`](https://github.com/tester-army/e2e/commit/d228e22ea309107cd42283bcfcb5f614ca3ea8c6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: each `agents` entry is one plain object. The built-in agent takes `model`, `judge`, `system`, `context`, `tools` (from `defineTool`), `maxSteps`, `maxModelCalls`, `judgmentTimeout`, `maxObservationBytes`, `maxInputTokens`, and `providerOptions` in the entry itself: `agents: { default: { model, system, tools } }`. A custom brain goes under `executor`, where `model`, `judge`, `context`, and the budgets still apply and `system` or `tools` fail with `INVALID_CONFIG`. Every entry starts from the built-in defaults; none inherits `default`'s values.
  
  `createAgent()` is removed from `e2e/agent`: write its options as the entry itself. A bare `StepExecutor` as an entry fails naming `{ executor }`. The agent key `timeout` is now `judgmentTimeout`, `maxTurns` is gone from the entry and from `createToolLoopExecutor` (use `maxModelCalls`), and the top-level `limits` key is removed: `maxModelTokensPerCall` is now each agent's `maxInputTokens`, and `maxAgentContextBytes` (16384), `maxLedgerBytes` (8192), and `maxEventsPerStep` (1000) are fixed. Each removed key fails with `INVALID_CONFIG` naming its replacement, and an unknown agent key names the nearest one. The report's `run.limits` block keeps its shape, filled from the largest per-agent values and the fixed ones. Project tools are validated at config load, and `e2e mcp` serves the agent's `tools`. `e2e init` writes the plain object.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the `TraceCacheStore` type is now `CacheStore`, and the docs and the CLI call the cache the replay cache. The `cache` config key and its options are unchanged; a `cache.store` built against the old name only needs its type import renamed.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `secrets.get(name)` works in `e2e.config.ts`: called before a run exists, it returns a reference by name for an engine option to hold, and the config load fails with `INVALID_CONFIG` when no `secrets` entry or credential has the name. An engine declares the handles its options hold in `defineEngine({ secrets })` and reads each value in `startAttempt` through the new `EngineAttemptContext.resolveSecret(secret)`, which runs a provider fresh and registers the value for redaction before it returns; the trace of such an attempt, which can record the engine's options, is rewritten through the redactor as after a fill, its screencast frames dropped. `e2e/engine` exports `isSecret`. Code that builds an `EngineAttemptContext` itself, such as an engine's own tests, now passes `resolveSecret`. The config docs show `process.loadEnvFile('.env')` for loading an env file.

- [#641](https://github.com/tester-army/e2e/pull/641) [`8a65a90`](https://github.com/tester-army/e2e/commit/8a65a9093d75a9e819bfc610cd7ebaf8055497a6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e explore --session <name>` starts the exploration signed in. The run collects the config's test files, runs the one setup test that declares the session, and restores it into the exploration, as a test with `{ session }` does; the planner and the agent are told they start signed in. A name no setup test declares is `COLLECTION_ERROR` before any app process starts, and that message now lists the sessions the setup tests declare, with the nearest one, for `e2e run` too. A setup that filled a secret keeps the exploration's screenshots withheld; one that signed in without filling one, by setting a cookie say, leaves them available.

- [#634](https://github.com/tester-army/e2e/pull/634) [`ec1ea1e`](https://github.com/tester-army/e2e/commit/ec1ea1e4c3142661897e0c23654e0aba2c43dbaa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp` holds several sessions at once, up to `--max-sessions` (default 4), so parallel agents such as a coding agent's subagents each drive their own browser or device. A call names its session by id and may leave it out only while one is open; with several open it fails with `SESSION_REQUIRED`. Each session loads the config afresh down to the files it imports by path, so a config that spreads a base config still gets its own engine per session, sessions on the same app command share one process that stops when the last of them closes, and sessions open at once share one config (`CONFIG_IN_USE` otherwise). A session holds its slot, its engine, and its app processes until its attempt has closed.
  
  The skill has a new `bug-bash` topic: parallel `e2e explore` charters, merging their findings, and proving each with a repro test that fails for the reason reported.

- [#612](https://github.com/tester-army/e2e/pull/612) [`04a1261`](https://github.com/tester-army/e2e/commit/04a126191eb9fefc730b93cd249f7c152e0166d1) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp` sessions record video on demand. The catalog gains `start_recording` and `stop_recording` when the engine records video: a coding agent starts a recording once the screen is set up and stops it when the part worth watching is over, and gets back the path of each file under `.e2e/videos/<session>/`, ready to attach to a pull request. `close_session` saves a recording still running, a recording stopped after a secret was filled says the video may show it, and `e2e init` adds `.e2e/videos/` to `.gitignore`. A session no longer records from launch when the config asks for the `video` artifact kind; that kind is for runs.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: a run's results live under one `output` directory, and `--artifacts` is gone. `output` (default `.e2e`, relative to the project root) and `--output <dir>` on `run` and `explore` hold `report.json`, `junit.xml`, `summary.md`, `failures/`, `ai-trace.json`, `artifacts/`, `sessions/`, and the `e2e mcp` session files (`artifacts/`, `videos/<session>/`); `--last-failed` reads `<output>/report.json`. Nothing derives the report's place from the artifact directory any more. `--artifacts <dir>` fails with the `--output` it maps to (`--artifacts out/artifacts` is `--output out`), and `RunOptions.artifactsDir` and `ExploreOptions.artifactsDir` are now `output`. A run clears `<output>/artifacts` when it starts, so it holds that run's evidence only. `cache.dir` stays independent (default `.e2e/cache`). An `output` that is the project root or outside it, the cache directory or inside it, one that would put `cache.dir` under a directory the run clears, or one that holds a `tests` glob's directory fails with `INVALID_CONFIG` naming the reason. `ArtifactStore` gains an optional `putLink(link)` that receives each provider-hosted video link (`StoredArtifactLink`: `url`, `mediaType`, `redaction`, `runId`, `testId`, `attemptId`, `startedAt`, `stepId?`) and returns a `ref` the report records beside the `url`; a passed attempt's link under `retain-on-failure` is never handed over, and a failing `putLink` never fails the run.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `trace` is a recording mode like `video`, and `artifacts` holds only `store`. `trace` and `video` share one `RecordingMode` type (`VideoMode` is gone): `'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries'`, the last recording every attempt after the first. `trace` is set at the config root, on a target, with `--trace [mode]` on `run` and `explore` (a bare `--trace` is `on`), and on a test or describe, with the same precedence as `video`: config, then target, then the flag, then the test. It defaults to `on` locally and `on-first-retry` in CI, and a retry mode with `retries: 0` prints a notice at plan time that no traces will be recorded. A serial group's members cannot set `trace` (`COLLECTION_ERROR`). The artifact kinds list (`artifacts: ['screenshot', 'trace']`, `artifacts.kinds`) and `artifacts.trace.record` are removed and fail with `INVALID_CONFIG` naming the `trace` mode they meant; a failure's screenshot and screen text are always captured when the engine can. A mode from the config root or a flag now applies only to the targets whose engine can record that kind, with one notice naming the others, where `--video` on an engine that cannot record used to fail the run; a mode set on a target or a test is still required, and fails the run with `UNSUPPORTED_ARTIFACT` naming the target and the test. `e2e explore` and `e2e mcp` sessions are one attempt, so retry modes record nothing there. Neither `trace` nor `video` enters the config digest. `RunOptions` and `ExploreOptions` gain `trace`.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `specVersion` is gone from the config. The runner version is the format version, so a config that still sets `specVersion` fails with `INVALID_CONFIG` telling you to remove it. The report's `run.specVersion` and the replay cache key are unchanged.

- [#626](https://github.com/tester-army/e2e/pull/626) [`636acd9`](https://github.com/tester-army/e2e/commit/636acd901f03dbff9e657dcce10d98634f88a1ab) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `tap`, `click`, `doubleTap`, and `secondaryTap` take `{ modifiers: ['Shift'] }`, the keys held for the click, as Playwright's `click({ modifiers })` does: a Shift-click that extends a table selection. An engine opts in with `tapModifiers: true`; on one that does not (the mobile engine), a call with modifiers fails with `UNSUPPORTED_CAPABILITY` before the node resolves instead of clicking without them. An unknown or repeated modifier, or `modifiers` beside `position`, is `INVALID_ARGUMENT`.

- [#620](https://github.com/tester-army/e2e/pull/620) [`a411ac6`](https://github.com/tester-army/e2e/commit/a411ac65245fd3602acc731a051e9726f75756aa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByTestId` takes a RegExp as well as a string, as Playwright's does: `screen.getByTestId(/total-budgeted$/)`. A string still matches the whole id, case-sensitive. Both engines already matched a pattern; only the SDK signature refused one.

- [#645](https://github.com/tester-army/e2e/pull/645) [`d7a218a`](https://github.com/tester-army/e2e/commit/d7a218af0788a5957c789203b811a690d0e9ccb3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `tests` globs take `!` exclusions: `tests: ['tests/**/*.e2e.ts', '!tests/wip/**']` runs every test file except those under `tests/wip/`. A file runs when an including glob matches it and no exclusion does, in any order, and discovery never reads a directory an exclusion takes whole. A list of only exclusions fails with `INVALID_CONFIG`.

- [#610](https://github.com/tester-army/e2e/pull/610) [`aadcb5d`](https://github.com/tester-army/e2e/commit/aadcb5dddb79217608a88c75af6cc4e5a582c592) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: video is its own option with Playwright's modes, and `artifacts.kinds: ['video']` and `artifacts.video: { retain }` are gone; a config that still uses them fails with `INVALID_CONFIG` naming the replacement. `video: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries'` is set at the config root, on a target (`targets: [{ engine, video: 'on-first-retry' }]`), for one run with `--video [mode]` (a bare `--video` is `on`), and on a test or describe (`test('checkout', { video: 'on' }, ...)`), the innermost winning; a serial group's members follow the group. `retain-on-failure` keeps only the recordings of attempts that did not pass, and `on-first-retry` records only the first retry, so a test that passes first time costs nothing. A video can be a link to a recording a hosted service keeps (the artifact's new `url`), which the list reporter prints and the run page links. The engine contract's `VideoSegment` is a file or a link, and `e2e/engine` exports the provider recording seam every engine shares: `ProviderRecording`, `ProviderRecordContext`, and `stopProviderRecording`. `RunOptions.video` is a mode instead of a boolean.

### Patch Changes

- [#638](https://github.com/tester-army/e2e/pull/638) [`12fe125`](https://github.com/tester-army/e2e/commit/12fe12550d37cfefe36b65a30d53ae4eb024d641) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e explore` writes its artifacts under a short directory named from the goal's first words and a digest of the whole goal, such as `web/explore-check-the-cart-totals-1a2b3c4d5e6f7a8b/default/attempt-0/finding-1.png`. It used the percent-encoded goal, cut at 120 characters, so every finding path in the terminal, `summary.md`, and `report.json` repeated the goal. Ordinary tests keep their directories.

- [#617](https://github.com/tester-army/e2e/pull/617) [`0cb74d6`](https://github.com/tester-army/e2e/commit/0cb74d6d916e62c38aeb05ce97658d3c67468843) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` keeps an existing `package.json` in the order the project wrote it. Parsing put the fields it validates first, so `scripts` and `devDependencies` moved to the top of the file and the diff rewrote the whole manifest. New dependencies join a sorted `devDependencies` block in order.

- [#627](https://github.com/tester-army/e2e/pull/627) [`425fd67`](https://github.com/tester-army/e2e/commit/425fd6765738da199a8dfbafa2d072294dd81822) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A bare `locator.longPress()` holds for the engine's own default instead of 500 ms. The SDK filled in 500 ms before the engine saw the action, so the mobile engine's one-second hold never applied, and a React Native `Pressable` with a `delayLongPress` above half a second read the press as a tap. The web engine still holds 500 ms.

- [#615](https://github.com/tester-army/e2e/pull/615) [`968b055`](https://github.com/tester-army/e2e/commit/968b05545db8c961bf864bcb2aa3fdfd59c626f8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A run narrowed by positionals (`e2e run tests/login.e2e.ts`) no longer fails on a test file it did not select that fails to import or register its tests, such as a half-written file elsewhere in the suite: the file is skipped with a notice. A collection error in a selected file, or in any file of an unnarrowed run, still fails the run, and a selected test whose session setup is then missing names the skipped file as where it may be.

- [#640](https://github.com/tester-army/e2e/pull/640) [`97a7e7f`](https://github.com/tester-army/e2e/commit/97a7e7f12129b029d53f28458c2a7ea72c083ea4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Agent and MCP observations show a link's whole target. The web engine cut `href` at 80 characters with no marker, so a link to `/projects/<uuid>` read as one to a truncated id. A target on the app URL's origin now renders as its path, complete and shorter than the URL, and any other keeps its origin; a dropped query or fragment shows as `?…` or `#…`, a `data:` or `javascript:` payload as `data:…` or `javascript:…`, and a target past 256 characters ends with `…`, in the line the model reads and the tree a custom executor gets. `mailto:`, `tel:`, and `blob:` links keep their scheme.

- [#623](https://github.com/tester-army/e2e/pull/623) [`85a3afd`](https://github.com/tester-army/e2e/commit/85a3afd7c41b6b28af84bd3182671fabaeec871e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `locator.waitFor()` or `screen.scrollUntilVisible()` that times out carries the locator facts on its `LOCATOR_NOT_FOUND` (locator, role, name, test id, time waited), so the failure lists the closest nodes on screen as the other locator failures do. A near miss also counts a word one typo away from the one asked for (words of four letters or more), so the menu item `Notes` answers a request for `Note` and the button `Submit` one for `Sumbit`.

- [#616](https://github.com/tester-army/e2e/pull/616) [`ba0d280`](https://github.com/tester-army/e2e/commit/ba0d2804194d8985beb0760ab1fa1e9e945b6aaa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Tests and config can import a workspace package that exports its TypeScript source, the monorepo internal-package pattern, when that package declares no `"type": "module"`. The file loaded as CommonJS, which the TypeScript loader does not transform, and failed as `Cannot find module` on a path that exists; TypeScript outside `node_modules` now loads as ESM whatever specifier reached it. For TypeScript inside an installed package, which keeps its declared format, the error now says the file exists and why it failed.

## 0.15.0-canary-20260928184528

### Minor Changes

- [#602](https://github.com/tester-army/e2e/pull/602) [`67c29fc`](https://github.com/tester-army/e2e/commit/67c29fc6b207822c9525360e6bf9c3130411a947) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engines and the reporter publish under the `@e2e-dev` scope: `@e2edev/web` is `@e2e-dev/web`, `@e2edev/mobile` is `@e2e-dev/mobile`, and `@e2edev/github` is `@e2e-dev/github`. The `@e2edev` packages get no new releases. To move, swap the dependencies (`npm uninstall @e2edev/web && npm install --save-dev @e2e-dev/web`) and rewrite the imports: `from '@e2edev/web'` becomes `from '@e2e-dev/web'`, and the same for `@e2edev/mobile`, `@e2edev/mobile/tools`, and `@e2edev/github`. `e2e init` installs and imports the new names.

- [#589](https://github.com/tester-army/e2e/pull/589) [`75e4145`](https://github.com/tester-army/e2e/commit/75e414536da73a23f37e213aab0a0880cd5869df) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `--repeat-each` run ends with a `Repeats` row in the `list` summary (`1 of 2 tests passed all 5 runs`) and one line per test that did not pass every run, naming each run that failed and its error code (`3/5 passed · repeat 1 ASSERTION_FAILED · repeat 3 flaky (STEP_TIMEOUT)`). The `markdown` page carries the same tally. A flake, and the fix for it, now read as a pass rate instead of results to count.

- [#586](https://github.com/tester-army/e2e/pull/586) [`d6947bc`](https://github.com/tester-army/e2e/commit/d6947bc66dca1d1d51dff20a67198f7929e1dfb5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `--strict-cache` and `cache: { strict: true }` fail a step whose recording exists but no longer replays with `REPLAY_STALE` (exit 2, not retried), instead of handing the step to the agent. A committed recording that a UI change broke used to pass live and spend model calls on every CI run until someone re-recorded it; now it fails in the pull request that broke it. Steps with no recording, retries, and values read off the screen still run live.

### Patch Changes

- [#548](https://github.com/tester-army/e2e/pull/548) [`89e2a19`](https://github.com/tester-army/e2e/commit/89e2a19a3932adf0bdbb3c2b2b8df7527f3a3750) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Two tests in one run whose ids differ only in characters the artifact directory name cannot hold (`artifact a` and `artifact_20a`: the space percent-encodes to `%20`, and both `%20` and `_20` became `_20`) shared one artifact directory, so the second test's failure screenshot and screen text wrote over the first's and the first report entry's `sha256` no longer matched the file on disk. A directory name the safe alphabet rewrote now ends in an 8-hex digest of the whole id, as a name past the length cap already did, so every test keeps evidence of its own. A test id holds a `/` and a `::`, so every test's artifact directory and its `.e2e/failures/` page name move once to the digested name; the paths in `report.json` match what is on disk.

- [#545](https://github.com/tester-army/e2e/pull/545) [`f9f49f4`](https://github.com/tester-army/e2e/commit/f9f49f41ef521fd712db340ab291afa58e259ec6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getAttribute` and `toHaveAttribute` only answer attributes the element carries. The attribute map reached both as a plain object and was read by name alone, so an attribute named like an `Object.prototype` member leaked the member: `expect(button).toHaveAttribute('constructor')` passed on a button with no such attribute, `.not.toHaveAttribute('constructor')` failed with `attribute "constructor" undefined`, and `getAttribute('constructor')` handed back a function instead of `null`. Every read now goes through one own-property lookup, an absent attribute is `null` whatever its name, and a real `constructor="x"` attribute still reads as its string. The web engine builds the map without a prototype for the same reason.

- [#558](https://github.com/tester-army/e2e/pull/558) [`676a015`](https://github.com/tester-army/e2e/commit/676a0153d88c9fb20d74e06c847e9303e18c4b59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The trace cache no longer records a step whose `unique()` value collides with another param. A recording is text with no note of which param a value came from, so `act('fill the title {title} and choose {frequency}', { params: { title: unique(title), frequency: 'Daily' } })` recorded while the title happened to be `Daily` stored the `select` of the plain choice as the title's slot, and the next run selected its new title as the frequency. Such a step now runs and passes as before but writes no entry, and `step.cache.notRecorded` in the report reads `param-collision`; the next run, with a value of its own, records it. The recorded verdict summary is also no longer rewritten: it stays as the model wrote it during the recording run, since a value spelled inside its prose came back as the current run's value in text the run never produced. Entries recorded earlier still replay; only their verdict text fills the slot they carry.

- [#570](https://github.com/tester-army/e2e/pull/570) [`8ff15d7`](https://github.com/tester-army/e2e/commit/8ff15d7cb2541490d29d0bb2dc64c2e9bcd1f126) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `toContainText([...])` holds when each entry is contained by a distinct match, in order, with extra matches allowed, as Playwright's does. It used to need exactly as many matches as entries, so `not.toContainText(['Deleted item'])` passed on a list of three items where one read `Deleted item`, and `toContainText(['Alpha', 'Gamma'])` failed on `Alpha`, `Beta`, `Gamma`. `toHaveText([...])` still needs the count to match.

- [#600](https://github.com/tester-army/e2e/pull/600) [`786f65d`](https://github.com/tester-army/e2e/commit/786f65d8e4ede28c833717374cea6a23cd1b7164) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A secret cut short by an observation limit is redacted in any case, not only as typed. An editor under CSS `text-transform: uppercase` echoing a filled credential after filler showed the upper-cased cut value in the model input, `failure/screen.txt`, and the report, since the cut match and the trace's fragment scrub compared the value exactly while whole-value matching already ignored case. Both now compare case-folded, as whole values do; a case mapping that changes length (`ß` as `SS`) and a collapsed whitespace run are still not followed there.

- [#561](https://github.com/tester-army/e2e/pull/561) [`c089fa6`](https://github.com/tester-army/e2e/commit/c089fa6cc21a3de7b925123b3e9fd8cf4165e29a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `download` artifact no longer claims `redaction: 'complete'` for bytes the runner never looked at. A file the app served is recorded `incomplete` unless a secret was filled on the session and the download is text (`.txt`, `.csv`, `.json`, `.html`), in which case the runner rewrites it through the secret ledger before hashing or storing it and labels it `complete`. `StoredArtifact` now carries that `redaction`, so an `artifacts.store` that exports only what the runner vouches for can tell a rewritten export from one that may still hold a filled value.
  
  The secret redactor also matches a value whose double quotes are doubled, the way CSV writes a quoted field, so a rewritten CSV export no longer keeps such a value.

- [#537](https://github.com/tester-army/e2e/pull/537) [`61603e6`](https://github.com/tester-army/e2e/commit/61603e6c2c103013eee2fe98c72066d59ac9363b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A reporter's `FinishedRun` carries `lastRun` on a `--last-failed` run: the report the rerun selected from. The rerun's own report lists the tests it left out as unselected, so a reporter that keeps one place current can fold the rerun into the run before it and show both as one.

- [#576](https://github.com/tester-army/e2e/pull/576) [`90356f1`](https://github.com/tester-army/e2e/commit/90356f17fcf515a0f05e4745235f645243acb51d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `--last-failed` runs a failed `beforeAll` or `afterAll`'s tests again. A hook failure is a run error no test result carries, so a test whose body passed while its `afterAll` threw was left out of the rerun: the rerun exited 0, or with nothing else failing found no tests. The report's hook error now carries a `scope` beside `scopeId`: its `file`, `targetId`, and describe `titlePath`. `--last-failed` selects every test in that describe or file on that target, and for a setup the tests that consume its session, until a run where the hook passes. A report whose hook error has no `scope` selects every test.

- [#569](https://github.com/tester-army/e2e/pull/569) [`301e71d`](https://github.com/tester-army/e2e/commit/301e71d09be40c9f26c3bc4853d8f70d19b24d66) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every locator action rejects an option it does not take with `INVALID_ARGUMENT` before the node resolves, as `tap()` and `click()` already did. Before, `check()`, `uncheck()`, `fill()`, `press()`, `selectOption()`, `hover()`, and the other timeout-only actions ignored the key: a JavaScript test passing Playwright's `{ trial: true }` really toggled the box, change events and all.

- [#575](https://github.com/tester-army/e2e/pull/575) [`ac3eb57`](https://github.com/tester-army/e2e/commit/ac3eb57477137c5106d84d997745558f86be22ca) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `locator.filter()` fails with `INVALID_LOCATOR` on any key other than `hasText` and `has`, even when one of those is present too: `filter({ hasText: 'Invoice', hasNotText: 'Paid' })` used to drop `hasNotText` and match the paid row. `locator.selectOption()` fails with `INVALID_ARGUMENT` before acting on anything but one option (a label string or exactly one of `{ label }`, `{ value }`, `{ index }`): an array of options used to select only its first entry. Option bags checked for unknown keys must be plain objects, and a non-enumerable key counts, so an inherited or hidden key can no longer slip past the check.

- [#581](https://github.com/tester-army/e2e/pull/581) [`c1e9029`](https://github.com/tester-army/e2e/commit/c1e9029fed3ff5d58b147877228132e6a016ae86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A plain field whose value or text holds a registered secret no longer lists its `selection` in an observation. Selecting part of a secret in a text field showed those characters to the model, in the executor tree, and in `failure/screen.txt`, because redaction matches whole values only; the selection is now dropped the way a secure field's is. So is the selection of a field cut at its length limit that is not in the part shown.

- [#538](https://github.com/tester-army/e2e/pull/538) [`dceae62`](https://github.com/tester-army/e2e/commit/dceae627300c2746b0a902cb90df75a0e1bb45a9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The markdown run page (the `@e2e-dev/github` comment, the job summary, `summary.md`) reads top down. Each failure's title has the line to look at right under it, with the target when several ran; a failed step that is not the agent's is one code span, the call it was; each kind of evidence links to the run's artifacts on its own, and the file paths inside the upload are gone from the comment (the download has one directory per test, named after it); `summary.md` keeps the paths, since a reader with the checkout can open them. Attempts that failed alike in a row fold into one clause: `at step 8, then at step 20 (3 times)`. A run that selected one of several configured targets (`--target android`) names it only in the footer; a test row under a file row no longer repeats the target the file row names.

- [#580](https://github.com/tester-army/e2e/pull/580) [`cf59269`](https://github.com/tester-army/e2e/commit/cf592694fea667dc25faaa514f3d65c7e13f63df) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An observed name or text the engine cut at its length limit no longer leaks the start of a secret it stopped partway through. When a cut field ends with 8 or more leading characters of a registered value (half of a value shorter than 16), that part becomes `<secret:name>` in model input, the failure screen, reports, and the trace cache. A Playwright trace from a session a secret was filled on also masks any run of 8 or more characters of a registered value, since it keeps the page's text as read, before any cut was redacted.

- [#577](https://github.com/tester-army/e2e/pull/577) [`3e1a568`](https://github.com/tester-army/e2e/commit/3e1a5685b7336915da67ff4ef4cdfdf580f5e2d5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Redaction catches a secret the page shows transformed. Each character of a registered value now matches in either case, full and locale-specific mappings included, so a value under CSS `text-transform: uppercase`, `lowercase`, or `capitalize` no longer survives in failure messages, report JSON, Markdown, or terminal output. A whitespace run inside a value also matches any shorter whitespace run, down to the single space a text reader collapses it to, and a value with edge whitespace also matches trimmed while that leaves at least 6 characters, so a multi-line secret echoed in a `<pre>` no longer reaches the model-bound observation, the report, or a saved trace as one line. Text that differs from a secret only in case is now redacted too. Assertions are unchanged.

- [#564](https://github.com/tester-army/e2e/pull/564) [`cb84c13`](https://github.com/tester-army/e2e/commit/cb84c13d8664c9637c19b9b9491cd727a0dfbb80) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Count screen capture time and delays after an action toward its wait for a visible change. A slow mobile capture or a later observation no longer starts that wait again. The following screen stability check remains in place, and empty navigation captures without screenshot evidence keep polling within its window.

- [#567](https://github.com/tester-army/e2e/pull/567) [`21b43b6`](https://github.com/tester-army/e2e/commit/21b43b6eb819b87d3c31fb5cdea36d10eac575ee) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `screen.scrollUntilVisible` fails as `LOCATOR_NOT_FOUND` whenever its deadline is why a swipe ran out of time. Each swipe gets the deadline's remainder as its budget, and an engine honouring that budget can report its timeout a millisecond before the runner's clock reads the deadline as passed, so the same scroll surfaced as `ACTION_FAILED`, or as the engine's raw timeout, depending on which timer woke first. The scroll now owns that outcome: a swipe timeout within one poll interval of the deadline is the deadline. An engine timing out on its own clock with the deadline still far away stays `ACTION_FAILED`.

- [#573](https://github.com/tester-army/e2e/pull/573) [`299c546`](https://github.com/tester-army/e2e/commit/299c546468a7e4cacc4084cfe0892c161530e333) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect(locator).toHaveAttribute` refuses a secure field with `POLICY_DENIED`, the way `getAttribute()` already did. The engine withholds a password field's `value` attribute, and the matcher read that gap as absent, so `not.toHaveAttribute('value')` passed on `<input type="password" value="...">` and `toHaveAttribute('value')` failed with `observed: attribute "value" absent`. Now the matcher throws before it judges, for every attribute name and negated too, and the message never carries the value. Plain fields are unchanged.

- [#547](https://github.com/tester-army/e2e/pull/547) [`2e96878`](https://github.com/tester-army/e2e/commit/2e968783bf6283d9fd507f06af1b559b323699db) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `expect(locator).toHaveValue`, `toHaveText`, and `toContainText` refuse a secure field with `POLICY_DENIED`, the way `inputValue()` and `textContent()` already did. The engine withholds a password field's value and text, and the matchers read that gap as `''`, so `toHaveValue('')` passed on a field that still held a password and a test checking that a sign-in form was cleared could pass falsely; `.not.toHaveValue('')` failed with `observed: value ""` for the same reason. Now the matchers throw before they judge, negated or in list form too, and the message never carries the value. `toHaveAccessibleName` and the state matchers still answer on a secure field. Plain fields are unchanged, and an empty non-secure control still reads as `''`.

- [#544](https://github.com/tester-army/e2e/pull/544) [`a399bac`](https://github.com/tester-army/e2e/commit/a399bac83b927f8c5a58f4906bc25f1b992754ad) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A session file's name tells the target and the session name apart. Before, the store wrote `<target>--<name>.json`, so target `a--b` with session `c` and target `a` with session `b--c` shared one file, the second save overwrote the first, and with two workers the consumer of the overwritten one failed with `SESSION_MISMATCH` (exit 2) after both setup tests passed. The name now ends in a 16-hex digest of the pair, which is what keeps two pairs apart, behind a readable prefix of each part escaped outside ASCII letters, numbers, and `_` and cut to 40 characters, so no part can hold a path separator or a `..` segment and a 128-character session name with any target name stays well under the 255-byte file name limit. Sessions live for one run and are deleted at cleanup, so nothing needs migrating.

- [#559](https://github.com/tester-army/e2e/pull/559) [`d0359eb`](https://github.com/tester-army/e2e/commit/d0359ebeef65835771667379c4fa51171fe670bb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A restored session keeps the secret protection of the setup test that saved it. Before, a secret resolved from a provider function and filled during setup was known only to that setup's session: a consumer test that restored the session and met the stored value again (an app echoing a token from local storage, say) printed it raw in the assertion failure, the report, the log, and the failure screen, while a static config secret in the same flow stayed masked. The saved session now carries the values the saving session learned inside its encrypted payload, and its taint, so the consumer redacts them and withholds pixels the same way. Nothing is written unencrypted; the envelope names the secrets, and the session schema gains an optional `secrecy` field.

- [#563](https://github.com/tester-army/e2e/pull/563) [`11a286d`](https://github.com/tester-army/e2e/commit/11a286d54fc58ce1fc19d3317aa41122b271a1fd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Avoid an extra 500 ms change wait after the agent scrolls to text on a device. The final page has already settled; the next observation still checks stability. This applies to live execution and replay, while engines that scroll the final node into view keep their change wait.

- [#572](https://github.com/tester-army/e2e/pull/572) [`bad98ea`](https://github.com/tester-army/e2e/commit/bad98ea2ebd4ab30fb7408b9b40467ea6a18caa9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A Playwright trace from an attempt that filled a secret no longer keeps its screencast frames. A secret filled into an ordinary visible field showed in those JPEGs while `app.screenshot()` was denied and the trace said `redaction: 'complete'`. The runner now drops every `screencast/` entry, every `screencast-frame` record, and any image a record names when it rewrites the trace, so the label holds; the actions, DOM snapshots, and network stay. A trace from an attempt that filled no secret keeps its frames.

- [#571](https://github.com/tester-army/e2e/pull/571) [`93b45b7`](https://github.com/tester-army/e2e/commit/93b45b79c77ae78a9069e6442df51413771fc3bd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A URL or text pattern that is neither a string nor a `RegExp` is `INVALID_ARGUMENT`. Before, a Playwright-style predicate read as a regexp with no source, which matches everything: `expect(web).toHaveURL(url => ...)` passed on any page, `web.waitForURL(fn)` resolved at once, `web.waitForResponse(fn)` returned the first response of any kind, `web.route(fn, handler)` intercepted every request, the document included, and `expect(value).toMatch(fn)` passed on any string. A text matcher or query given one, such as `toHaveTitle(fn)` or `getByText(fn)`, threw a raw `TypeError`. `toTextPattern` and `urlMatches` in `e2e/engine` throw the same error, so an engine that uses them refuses such a pattern too. A `RegExp` from another realm is still a `RegExp`.

- [#556](https://github.com/tester-army/e2e/pull/556) [`d87465b`](https://github.com/tester-army/e2e/commit/d87465b77fe1e04e981e9bddeaddd732c33c9861) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `web.route` or `web.onDialog` handler that failed after the test's last step no longer passes the test. The web engine kept such a failure for the next operation to throw, and a test that ended right after the request or the dialog had no next operation, so a failed `expect` inside the handler reported a pass; the same handler followed by a `web.url()` failed as expected. The runner now asks the engine to settle the attempt after the body and again after teardown, before the verdict: a handler still running gets the cleanup budget to finish, and the error it kept fails the attempt with its own code. A dialog handler's classified error (`ASSERTION_FAILED`, `POLICY_DENIED`) also keeps that code now instead of becoming an `ENGINE_FAILURE` infrastructure error, matching route handlers. Engines get an optional `settleAttempt` hook for this.

- [#591](https://github.com/tester-army/e2e/pull/591) [`eaac502`](https://github.com/tester-army/e2e/commit/eaac50292d4f71a0ca267263568be7152170c596) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The tree reads three controls the way Playwright's `getByRole` does: a `<select>` showing several rows (`size` above 1) is a `listbox`, an `<input>` whose `list` names a `<datalist>` is a `combobox`, and a `<td>` of a `role="grid"` or `role="treegrid"` table is a `gridcell`. A name read off the tree now finds the control with `getByRole`. A `listbox` counts as a control the agent can act on, as a `combobox` does.

- [#505](https://github.com/tester-army/e2e/pull/505) [`cef69d2`](https://github.com/tester-army/e2e/commit/cef69d26095a045d2282c9d43ad1f115e48b11dd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` opens with the e2e wordmark, the site's lettering drawn in block characters, written in letter by letter the way a pen writes it, with a dim edge of wet ink behind the pen, all in the terminal's own foreground. `e2e --help` prints the wordmark at rest above the help. Both show on a terminal at least 55 columns wide and never in piped output; with `--yes`, in CI, on a dumb terminal, and on a terminal shorter than 11 rows the wordmark prints without motion. Ctrl-C or SIGTERM while it is being written restores the cursor and exits 130.

## 0.15.0-canary-20260925150007

### Minor Changes

- [#514](https://github.com/tester-army/e2e/pull/514) [`43d76ce`](https://github.com/tester-army/e2e/commit/43d76ce760b4d62148d4e129c77cbedd8a6aec7c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `scroll_to` reaches a node the screen does not list yet. Given `text` instead of a node id, it pages the list (or the viewport) screen by screen in `direction` until a visible node reading that text shows, then brings it into the viewport when the engine can: for a row deep in a long or windowed list, which the tree lists only once it is drawn. One action of the budget however many screens it takes, up to 800; a screen that stops moving or the cap ends it as `LOCATOR_NOT_FOUND`, an action failure the model re-aims from. The step records it as one `scrollUntil` action with the list it paged, and the trace cache replays it by paging again. A device engine, which declares no `scrollIntoView`, now gets `scroll_to` in its text form. The text is read as a whole label or at a word boundary, never inside a longer number, and only inside the list being paged while it is on screen; a list whose rows keep one name while their text moves on counts as moving.

- [#516](https://github.com/tester-army/e2e/pull/516) [`ec503c2`](https://github.com/tester-army/e2e/commit/ec503c2ea3e031c457509b93195f608cb8fd0a73) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An observed node carries `selection`, the text selected inside the focused field or editing host, and the screen the agent reads renders it as `selection="..."` beside the value. A `press` of `Shift+ArrowLeft` now shows what it selected, and `press` takes `times` (1 to 20, each press one recorded action, as a scroll repeat is), so the agent extends a selection to exactly one word in one more call, where before it pressed blind, one key per turn, and bolded the wrong span. A secure field reports no selection, as it reports no value. The web engine reads it from an input's or textarea's selection range and from the document selection inside a `contenteditable` host; a collapsed caret reports none.

### Patch Changes

- [#519](https://github.com/tester-army/e2e/pull/519) [`d6a1a30`](https://github.com/tester-army/e2e/commit/d6a1a30519951a3e588d7fe6d73d4ff0ef433b89) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` writes the agent skill once. With `.agents/skills` and `.claude/skills` both chosen, the `--yes` default, the copy goes to `.agents/skills/e2e` and `.claude/skills/e2e` is a relative symlink to it (`../../.agents/skills/e2e`), the layout `npx skills add` produces, so one copy serves every agent. A project with two copies from an earlier version gets the link on its next `init` when the Claude Code copy holds nothing but the shipped files; one with other files in it stays a copy and is refreshed. A `.claude/skills/e2e` that already leads to the copy, itself or through a linked `.claude/skills`, needs nothing. A link elsewhere keeps its rules: skipped with a warning under `--yes`, and offered a replacement when asked, now the link rather than a second copy.

- [#520](https://github.com/tester-army/e2e/pull/520) [`c1547c9`](https://github.com/tester-army/e2e/commit/c1547c9deb9619b6f90e4a98712ea080551e61cc) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - Stop printing the one-time telemetry notice before `e2e init`; the first command after the scaffold prints it instead.
  
  `e2e init` lists the planned file changes one per line before asking to apply them, instead of joining them into one sentence.

- [#512](https://github.com/tester-army/e2e/pull/512) [`38e152a`](https://github.com/tester-army/e2e/commit/38e152a4aab06b4a1ce2ef46967b8f1931b3e35a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A point tap or hover recorded on a screen the tree lists poorly replays instead of handing off as `target-ambiguous` or `target-not-found`. When several nested look-alikes of the recorded container hold the point, a React Native host view and the view inside it under one label, the recorded point on a viewport of the recorded size names the same pixel whichever of them was recorded, and it is tapped as a bare point would be. Look-alikes that merely overlap under the point without nesting still hand off, since which one is on top may have changed. A container with nothing to re-find it by, a group among groups on a screen merged into one accessibility node, is no longer recorded at all: the point stands alone, and an entry that still carries one replays the point. A container that is gone still hands off.

## 0.15.0-canary-20260924194828

### Minor Changes

- [#501](https://github.com/tester-army/e2e/pull/501) [`7d93c08`](https://github.com/tester-army/e2e/commit/7d93c085eb7d7c56c4007b870ff7f8b5c644d3d2) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The agent gets a tool for each action its engine declares beyond tap and type: `hover` and `hover_at`, `double_tap`, `long_press`, `right_click`, `check`, `drag`, `scroll_to`, `upload`, and `back`. Each is offered only when the engine declares the action, records into the trace cache with the node it acted on, and replays zero-turn. `upload` takes project-relative paths and refuses, before the engine sees them, a file outside the project root or one that is hidden or under a hidden directory, as `POLICY_DENIED`. The new tool names are reserved: a project tool named like one is refused at `createAgent`, as `tap` and `scroll` already were.

- [#452](https://github.com/tester-army/e2e/pull/452) [`ee4929d`](https://github.com/tester-army/e2e/commit/ee4929ddb6aa4de9004efd2e9107157103fd3c2f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The public surface loses exports nothing outside the runner consumed: `BLOCKABLE_CODES`, `RUNTIME_CODES`, `buildTraceEntry`, and `readTraceEntry` from `e2e`, `isDefinedTool` and `toolAppliesTo` from `e2e/agent`, and the `store`, `apiUrl`, and `baseURL` options of `chatgpt()`, `copilot()`, and `grok()`, whose option types are gone with them. A `blocked` verdict still names a code from the table in the agent-steps guide, a custom `TraceCacheStore` still handles entries opaquely, and the constructors take only a model id; a login comes from `e2e login` or `E2E_OAUTH_CREDENTIALS`.

- [#479](https://github.com/tester-army/e2e/pull/479) [`4314f5f`](https://github.com/tester-army/e2e/commit/4314f5f8869b7d7369f1878b9ff23fd07790eb35) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e/engine` exports `resolveExpression`, the reference locator semantics over a semantic tree. It resolves one `LocatorExpression` over `SemanticNode`s in document order: every query kind, `visible`, scopes, `filter`, and `index`, with `text` and `label` answering the innermost match when a container echoes a descendant's text. An engine whose platform tree is the whole truth calls it instead of interpreting expressions itself. A `selector` goes to the platform hook it takes; a `frame` is `FRAME_NOT_FOUND`.

- [#460](https://github.com/tester-army/e2e/pull/460) [`fa41517`](https://github.com/tester-army/e2e/commit/fa415178000d435fb97b6f07b9e1f0feb7743019) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The secret redactor matches each value character by character, in every spelling a serializer gives a character: percent-encoding in lower-case hex, decimal and hex character references (`&[#39](https://github.com/tester-army/e2e/issues/39);`, `&#039;`, `&#x27;`), `\uXXXX` JSON escapes in either case, and a JSON-escaped slash all redact now, on top of the raw, JSON, HTML, and URL forms already covered. Base64, another Unicode normalization form, and a value spread over several nodes stay out of scope and are listed as such on the security page.
  
  A static secret or credential password shorter than 6 characters (code points) is `INVALID_CONFIG`, and a provider returning one fails the fill. Redaction rewrites every occurrence of a value, so `E2E_SECRET_PIN=7` turned every `7` in a report into `<secret:pin>`.
  
  A test's console output is redacted across writes: a value split over two `process.stdout.write` calls, or over the chunks of a piped child's output, no longer reaches the reporter in halves, a multibyte character split between chunks decodes whole, and a `<secret:name>` marker split the same way reaches the reporter whole. A write that ends mid-line holds back its tail until the next write, the next test's start, or the test's result, attributed to the test that wrote it.

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `app.open()` on a device target launches the pinned app fresh, the way Maestro's `launchApp` does; it takes no path there (a link goes through `device.openLink`). It was `APP_URL_REQUIRED` on every device target before.

- [#475](https://github.com/tester-army/e2e/pull/475) [`a0df697`](https://github.com/tester-army/e2e/commit/a0df69790679e02d7011dbaa3932028bac90b226) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `scrollUntilVisible` on a locator swipes that node instead of the viewport, so a feed or a table that is its own scroll container pages without the pointer having to hover it first: `screen.getByRole('feed').scrollUntilVisible(row)`. It takes `momentum` for the stride of each step (`'none'`, `'slow'`, `'fast'`; `'slow'` unless told otherwise), and an option it does not take is `INVALID_ARGUMENT` before any swipe, as on the other actions.

### Patch Changes

- [#449](https://github.com/tester-army/e2e/pull/449) [`ed151e0`](https://github.com/tester-army/e2e/commit/ed151e042080371ab47dbbec49aa296011b34370) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Typing into a listed node the engine cannot fill (a focusable canvas, a widget with its own key handling) no longer reads as a failed action: the result said `the control had no visible effect here: look for another way rather than repeating it` because the tree cannot list that node's text, and the model retyped or gave up. The keyboard fallback now says the tree does not list the text and asks for the app's reaction or a screenshot as the check, and any result whose listed nodes stood still while the attached screenshot changed says `listed nodes unchanged; the screenshot changed` instead of blaming the control. An inconclusive `agent.assert` judged from the tree alone adds `pass vision: true when the answer is in pixels` to its message, as a condition (`if the engine captures pixels, ...`) until a step of the attempt has received pixels, and not at all when the engine declares no screenshot capture, a secret was filled, or an earlier pixel request was degraded; a `waitFor` timeout after an inconclusive round carries the same hint.

- [#440](https://github.com/tester-army/e2e/pull/440) [`cc691d4`](https://github.com/tester-army/e2e/commit/cc691d472151d423637b3d22d477347644303068) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An `act` step in pixel mode, where every tool result after a `screenshot` call carries its text beside an image, gets the same loop discipline as a text-only step. The failure-streak guard read only text results, so three or five failed actions in a row after a screenshot never asked the model to change approach or forced a verdict; it now reads the text beside the image, and it recognizes a point verb's `tap_at (30, 30) failed:` lead, which its sentence-shaped rule had skipped. Superseded full screens that arrived with a screenshot were never elided, so a long pixel flow grew every turn until the provider refused the request and the step ended `CONTEXT_OVERFLOW` with "nothing left to shrink" instead of retrying; they now elide like text screens, the retry clips the newest one, and the image, or the notice that replaced it, stays in place.

- [#428](https://github.com/tester-army/e2e/pull/428) [`66fb1e3`](https://github.com/tester-army/e2e/commit/66fb1e3d369cc5789fc768e4258f63e0b7120e2f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The run summary's `AI` row names the models the steps reported, each with its call count when several answered (`typesafe-ai/jev (22 calls) · gateway/openai/gpt-5.6-luna (1 call)`), instead of echoing the configured model: a custom executor, an agent pinned to another model, or `--agent a,b` printed a label the per-step `model` records in `report.json` contradicted. The header line under `RUN` still names the configured model and judge.

- [#423](https://github.com/tester-army/e2e/pull/423) [`2ee94cc`](https://github.com/tester-army/e2e/commit/2ee94cc379779d62ab8e1b64a61852d25929bc93) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Two tests whose ids share their first 120 characters (a monorepo path, a describe, a long title) wrote their artifacts into one directory, so one test's `failure.png` and screenshots replaced the other's and the report's `path` and `sha256` named the wrong evidence. A test id past the cap now ends its directory name in a digest of the whole id, so each test gets its own; ids within the cap keep the names they had. A result's source file resolves against the project root as a directory, so a sibling directory sharing the root's prefix (`/repo/app-shared` beside `/repo/app`) is no longer reported as `-shared/...`; the report names the test file instead. Step and error source lines apply the same rule, and a project rooted at `/` keeps them.

- [#458](https://github.com/tester-army/e2e/pull/458) [`3c52f93`](https://github.com/tester-army/e2e/commit/3c52f93272832892d6b36456df89d638b0bca084) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The tools the agent calls have closed schemas. A field a tool does not declare (`force`, `selector`, a second target) used to be stripped and the call run without it; it now fails validation, and the refusal goes back to the model as the call's result, naming the field, so its next turn is the repair. A call to a tool the step does not offer is refused the same way, with the names it may use. Neither runs anything, both count toward the failure streak that forces a verdict, and the step's turns record them; a refused `complete_step` counts toward that streak too, so a model that resends one the schema turns away is stopped instead of running to the turn budget. A `complete_step` that pairs `status: "passed"` with an `errorCode` is accepted: the code is dropped, the step passes, and the turn notes the dropped code (one model sends a pass beside `ACTION_FAILED` about half the time, and refusing it produced a 12 to 19 call loop). `e2e mcp` `call` refuses an undeclared argument with `INVALID_ARGUMENT`, as it already did a wrong type.

- [#463](https://github.com/tester-army/e2e/pull/463) [`8802b0f`](https://github.com/tester-army/e2e/commit/8802b0f0dc85fdd0bcdccc5b4ba6b351000d1769) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` scaffolds `openai/gpt-6-luna-fast` as the example model for every gateway, and the docs and skill name it in their examples. On the two agentic suites it passes the same 37 tests as `gpt-5.6-luna-fast` at about a quarter of the cost, with 5 model calls instead of 14 on the lying-labels scenario.

- [#436](https://github.com/tester-army/e2e/pull/436) [`edbb84f`](https://github.com/tester-army/e2e/commit/edbb84f6a1fcc57f6f8f5e7f88155691a96df369) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The shipped skill installs from `@canary`, lists the MCP point tools (`tap_at`, `type_at`, `press_at`, `select_at`) with when each is served, lists `toHaveClass`, and names `secondaryTap` unsupported on a device; the `expect.any(Object)` JSDoc says `null` matches, as it does.

- [#504](https://github.com/tester-army/e2e/pull/504) [`91cacc9`](https://github.com/tester-army/e2e/commit/91cacc9e9ab6413308e3926885ec452d2e1a8371) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The run summary's `Duration` row repeats a span of a minute or more as minutes and seconds beside the seconds it printed alone (`682.97s (11m 23s)`), so a long run reads without arithmetic. The startup split shares that parenthetical (`(11m 23s, startup 43.00s)`) instead of opening a second one; a run under a minute prints as before.

- [#491](https://github.com/tester-army/e2e/pull/491) [`1de46ce`](https://github.com/tester-army/e2e/commit/1de46ce08c4943c17e4fdd16b0b18ee7a420307a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An `EngineError` thrown by a contributed fixture method (`device.foregroundApp()` after `device.closeApp()`, for one) is mapped onto the runner taxonomy the way every other engine surface's is: `INVALID_STATE` is `APP_NOT_OPEN`, `OPERATION_TIMEOUT` is `ACTION_FAILED`, `UNSUPPORTED_CAPABILITY` and `ENGINE_FAILURE` keep their codes. The fixture recorder let the engine code through untranslated, so a test read `INVALID_STATE` where the reference promised `APP_NOT_OPEN`. Errors that are not `EngineError`s are rethrown as the fixture threw them.

- [#483](https://github.com/tester-army/e2e/pull/483) [`7ef3553`](https://github.com/tester-army/e2e/commit/7ef3553b67c90d18cafe63e9a496a16344603608) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` and the docs name both credentials `gateway()` from `ai` accepts for the Vercel AI Gateway: `AI_GATEWAY_API_KEY`, or without it a Vercel OIDC token, a valid `VERCEL_OIDC_TOKEN` and otherwise one minted for the project linked with `npx vercel link` using the Vercel CLI login. The scaffolded config comment, the models and environment pages, and the agent skill said the key was the only one.

- [#435](https://github.com/tester-army/e2e/pull/435) [`881afee`](https://github.com/tester-army/e2e/commit/881afee5c4973988b4811680b642e6ab6b1ec7bb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run --help`, `e2e help run`, and `e2e --version` no longer count as a completed session of that command in anonymous telemetry: the session was named before commander parsed the flags and was sent with exit code 0 once the help had printed. They send nothing now.

- [#453](https://github.com/tester-army/e2e/pull/453) [`7aa0ffe`](https://github.com/tester-army/e2e/commit/7aa0ffe0b2425a5721bf5cf7a07335b03bd3c5b6) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` no longer writes the agent skill through a symlink. A `.claude/skills/e2e` or `.agents/skills/e2e` that is a link (to a dotfiles repo, a shared skills folder, anywhere) had its target's `SKILL.md` replaced and `references/` written there, silently under `--yes`. The link, or a linked parent, is now left alone: `--yes` prints `Symlink, not touching: <link> -> <target>`, and an interactive run asks before replacing the link with a copy, defaulting to no. A copy with a directory where `SKILL.md` or another file goes, or a file where `references/` goes, is skipped with `Broken, not touching: <dir>/ (<entry> is a directory)` instead of aborting init on the write.

- [#431](https://github.com/tester-army/e2e/pull/431) [`943de73`](https://github.com/tester-army/e2e/commit/943de73404259517ea8bdc7c36e6c830cb969142) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An interrupt lands every test the run had not started in `report.json` once, skipped with cause `infrastructure-unavailable` and the reason `run interrupted before execution`, so `--last-failed` after a Ctrl-C or a run-level model failure runs them again along with the interrupted test. A plain interrupt used to drop the queued files from the report, leaving `summary.discovered` short of the plan, and a `--max-failures` limit tripped by a serial group member reported the group's later members twice: once from the group and once more as skipped at the interrupt.

- [#499](https://github.com/tester-army/e2e/pull/499) [`920ac4e`](https://github.com/tester-army/e2e/commit/920ac4ebf03f10ff2848b0f6fb20914c640bad02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A judgment writes its explanation before its verdict, and the request tells the judge that quotation marks in an instruction delimit the words to look for rather than being part of them. On the mobile benchmark a fast model had failed `the screen shows the text "Access granted"` with the explanation that the screenshot showed “Access granted,” and once wrote "so the assertion holds" under a `fails` verdict; the verdict now follows the reasoning, and the schema lists the fields in that order for providers that emit structured output in schema order.

- [#454](https://github.com/tester-army/e2e/pull/454) [`e95135d`](https://github.com/tester-army/e2e/commit/e95135d5124c5008c79bc25b9f3cff8b89688d06) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A judgment explanation is measured in code points, the unit `maxLength` counts in `schema/agent-judgment-v2.schema.json`. An explanation with emoji or other astral characters that the schema accepts was rejected by the runner, which counted UTF-16 units.
  
  An `agent.assert` whose repair round is rejected as well fails `MODEL_OUTPUT_INVALID` with the rejection as the step's `explanation`, and both rejected answers are `schema` events on the step. The report used to omit the explanation there, which `schema/report-v1.schema.json` requires on a judgment step once a model call was made, so the runner wrote a report its own schema rejected.

- [#447](https://github.com/tester-army/e2e/pull/447) [`18cb9fc`](https://github.com/tester-army/e2e/commit/18cb9fcc3de47c4b49004f834a8d71fcc1f42f11) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The terminal reporters measure text in terminal columns per grapheme cluster instead of UTF-16 code units. The live window's clamp no longer leaves a lone surrogate (a garbage glyph before the ellipsis) or splits an emoji sequence; CJK glyphs and emoji sequences (`❤️`, a ZWJ family, a keycap, a flag) count the two columns they paint, so the block's erase matches what was painted and no stale fragments remain after a repaint. Step labels, reasoning excerpts, the exploration header and step summaries, and the failure glance line are clipped by column too, so a CJK label no longer pushes the duration off the row. A piped log changes only where it holds wide glyphs: the step label's 72-column budget, the failure glance and the exploration step summary against the 80 columns a pipe reports, and the wrapped finding details count columns now, so a CJK label keeps half the glyphs it did; ASCII output is byte-identical.

- [#430](https://github.com/tester-army/e2e/pull/430) [`7753859`](https://github.com/tester-army/e2e/commit/77538594af6df0ca03aadd58b25cd090645f2a92) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A saved subscription login the vendor rejects now fails naming the command that fixes it, `npx e2e login <provider>`, the way a missing login already did: a refresh token that is rejected, and a 401 on a token with nothing to refresh it (Copilot's GitHub token), both end as `LOGIN_REQUIRED` with the hint. Before, the run reported `MODEL_PROVIDER_FAILED: ... (401: ...); sign in again` with no provider id to type, and a revoked Copilot token surfaced as a bare HTTP 401.

- [#448](https://github.com/tester-army/e2e/pull/448) [`cdc4109`](https://github.com/tester-army/e2e/commit/cdc41098c7d3f5ba92705a87f758e470e859a559) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Screen text from the app under test can no longer notify anyone or plant a link from the markdown page and the `@e2edev/github` comment: a token GitHub would link on its own (`@someone`, `@org/team`, `[#123](https://github.com/tester-army/e2e/issues/123)`, `https://...`, `www....`, an email address) in a test title, an expected or observed value, the agent's explanation, a turn outcome, or an explore finding is shown as code, the one rendering GitHub's autolink filters skip, since entities and backslashes before `@` and `#` are undone before those filters run. A quoted line or the explore assessment that starts with `#`, `-`, `+`, `1.`, or `---` is escaped so it stays prose instead of becoming a heading, a list, or a rule. Target and agent names may no longer be only dots: `.` and `..` passed the name rule and became artifact path components, so a target named `..` wrote beside `report.json` with artifact paths the report-1 schema rejects; the sanitizer maps an all-dot segment to `_` as well.

- [#429](https://github.com/tester-army/e2e/pull/429) [`e2b5570`](https://github.com/tester-army/e2e/commit/e2b557074ff4f18aa437fae351ac0ced6f02f53a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e mcp`'s `locate` showed a filled secret in plaintext: it read the matching nodes straight from the engine and rendered `value` raw, hiding it only for a secure field, so after `type_secret` of a generic secret into a plain textbox (or a password fill followed by a show-password toggle) `call locate {label}` handed the value to the coding agent. Located nodes now go through the projection `observe` gives an executor, so a filled value reads `<secret:name>` and a secure node has none, and every text a `call` returns, results and errors alike, passes the attempt's secret ledger.
  
  The redactor never rewrites a marker it wrote. Text is cut at the `<secret:name>` markers of the names it knows and each marker it writes is final, so text that passes it twice reads as text that passed once, and a value that occurs inside a marker (`api` inside `<secret:apiKey>`, the word `secret`) no longer turns it into `<secret:<secret:apiKey>Key>`.

- [#485](https://github.com/tester-army/e2e/pull/485) [`0dcf6a4`](https://github.com/tester-army/e2e/commit/0dcf6a492722b2e275c2f6b943ba728e5abd8dac) Thanks [@okwasniewski](https://github.com/okwasniewski)! - An operation that times out within a poll tick of the step deadline is `STEP_TIMEOUT`. Its timer and the deadline mark one instant on two clocks, and on a loaded machine the timer fired a few milliseconds before the clock read the deadline as reached, so a `waitFor` polling a page that never changed ended as `ACTION_FAILED` "operation timed out" instead of the timeout that names its last judgment.

- [#506](https://github.com/tester-army/e2e/pull/506) [`c975fb2`](https://github.com/tester-army/e2e/commit/c975fb26cc92bae4f42e4f26bc7f92d8a2df562e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - OpenAI and Azure OpenAI requests carry `store: false` unless `providerOptions` sets it. The runner never reads a response back from the provider, and with storage on the AI SDK replayed a reasoning model's earlier turns by item id, so an organization with zero data retention, where nothing is stored, failed the second turn of every `act` step with `Item with id 'rs_…' not found`. Reasoning now travels inline as encrypted content, the prompt cache keeps working, and that failure names its remedy when a caller turns storage back on.

- [#451](https://github.com/tester-army/e2e/pull/451) [`1cb0c73`](https://github.com/tester-army/e2e/commit/1cb0c73c9ff846b5fef115a6bd3b805c0a540410) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `count()`, `all()`, `allTextContents()`, `isVisible()`, and `isHidden()` answer at once when the frame their locator is scoped to is not in the document: `count()` is `0` and `isVisible()` is `false`, as for zero matches. Before, the first three waited the whole action timeout and then failed with `LOCATOR_NOT_FOUND`, and `isVisible()` threw it immediately, so a `while (!(await widget.isVisible()))` loop against an iframe widget broke on its first pass. Actions and assertions keep polling for the frame. `isVisible()` and `isHidden()` now also re-resolve a node the engine reports stale, within the action timeout, where before they answered from a single attempt and threw `LOCATOR_NOT_FOUND` on a resolve that raced a navigation; a resolve still stale at the timeout throws as before.

- [#438](https://github.com/tester-army/e2e/pull/438) [`9c847ba`](https://github.com/tester-army/e2e/commit/9c847ba3e6f69ddbf84d39add17b7d993aadeb59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A replayed step keeps its typed values on an app that keeps state between runs. When the value a recording typed (a todo, a note title) was still on screen at the start of the next run, the replay judged it read off the screen and re-staged the step with a `type (run-time value)` gap, so from the third run on the step handed off to the model at that point every time. What a replay types is the recording's own data and is recorded as typed; the check for a value the agent read off the screen applies to the agent's own actions only.

- [#480](https://github.com/tester-army/e2e/pull/480) [`3bbcc96`](https://github.com/tester-army/e2e/commit/3bbcc968dddd1499db30b9a99ab949920cf98f74) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Trace-cache replay runs closer to the speed of the deterministic APIs: the first recorded action relocates on the step's settled start capture instead of capturing the same screen again, the look after a fill waits for the field to show its value without a beat proving the screen holds still, a folded scroll on a list takes one look per repeat, and a step the cache replayed whole keeps its entry as it stands, so the file keeps its bytes and `createdAt` and a committed `.e2e/cache/` stays clean across local runs; a re-recording that matches the stored flow apart from the summary and the measured end wait is not written either. The trade: a replay that still finds every control refreshes none of the entry's descriptors, anchors, or end wait, so drift is repaired only when a control can no longer be found and the agent takes the step over. How far the screen settles after each kind of action is now one policy the live loop and replay both read, so the two cannot disagree about the same action; after a secret fill, which the tree cannot show, the next look proves the screen holds still instead of reading it the instant the fill returns. A typed value counts as read off the screen only when it is the whole name or text of a control, or a token with a digit in it shown as a word of its own; a plain word the agent composed that also appears inside a sentence on screen ("one" beside "Row one") is recorded and replays instead of ending the recording as a run-time value gap. A `gap` at such a value now says which rule flagged it: `step.cache.derived` in the report is `whole-node`, `minted-token`, `date`, or `pixels`, and the recorded gap carries the same field. The `truncated` miss reason in the docs states the actual action ceiling.

- [#444](https://github.com/tester-army/e2e/pull/444) [`6efc77d`](https://github.com/tester-army/e2e/commit/6efc77da5e4ca69468b5ce1b4eb6ac625d5c7c63) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A reporter whose `onEvent` throws, or returns a promise that rejects, is still quarantined for the rest of the run, and now says so: one stderr line, `e2e: reporter "<name>" threw on <event type>: <message>; ignoring it for the rest of the run`, in the style of the `onRunFinished` diagnostics. Before, the reporter fell silent with nothing to say why.

- [#437](https://github.com/tester-army/e2e/pull/437) [`a9f8256`](https://github.com/tester-army/e2e/commit/a9f8256b800160eb88e6bb6efb69f767f9e2b000) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The package ships its wire-format schemas: every `schema/*.schema.json` is in the tarball, where the CLI reference and the `Report` type's JSDoc already pointed. The fixtures stay in the repository.

- [#507](https://github.com/tester-army/e2e/pull/507) [`cc23e51`](https://github.com/tester-army/e2e/commit/cc23e5142ec02dbecfbf555aa0d76e16c430c49a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI sends no telemetry when it runs from a source checkout of the repository: the package's `src` beside its `dist` turns it off, `e2e telemetry` reports `running from a source checkout of e2e`, and no notice prints. Work on e2e itself no longer counts as usage; an installed or unpacked package, which ships no `src`, is unaffected.

- [#457](https://github.com/tester-army/e2e/pull/457) [`5aaac75`](https://github.com/tester-army/e2e/commit/5aaac751f64141eb9fc80114ba945703ebc8709c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `toHaveValue` compares a form control's value as it is, newlines and trailing spaces included, and prints that raw value when it fails. It used to collapse whitespace on both sides, so `toHaveValue('line1 line2')` passed against a textarea holding `'line1\n\nline2  '` while the failure message showed a string that was never compared. A node with no value, such as a heading, no longer satisfies `toHaveValue('')` or passes `not.toHaveValue(...)` for free: the assertion keeps polling and fails with `observed: no value (not a form control)`. A control the platform reports without a value, such as a cleared field on a device, reads as the empty string. `toHaveAccessibleName` keeps comparing normalized names, as `toHaveText` does, and its failure message now prints the normalized name it compared.

- [#456](https://github.com/tester-army/e2e/pull/456) [`778fccc`](https://github.com/tester-army/e2e/commit/778fcccdfee595505b7905488aab9e3ff7067470) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `e2e` and `e2e/engine` types compile without the optional `ai` peer installed. The config, secrets, and run-event declarations under `dist/` no longer import from `ai`, so a project with a hand-rolled `StepExecutor` and no AI SDK sees no TS2307 from `node_modules/e2e` and needs no `skipLibCheck`.

- [#434](https://github.com/tester-army/e2e/pull/434) [`4305718`](https://github.com/tester-army/e2e/commit/4305718f1b43d362349698aaa28bac47d3e41271) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The public types say what the runner does. `E2EConfig.targets` is required at the type level, as the loader has always demanded: `({ cache: 'read-write' }) satisfies E2EConfig` no longer compiles and fails at load with `INVALID_CONFIG`. `ModelInstance` carries the `doGenerate` member the config check reads, so an object of three id strings is rejected by `tsc` rather than by the loader. `RunStatus`, `RunExitCode`, `StepTurn`, `PointHit`, `PointTapResult`, and `ExecutorVerb`, each named by a public signature, are exported from `e2e`. `agent.assert` under a custom `StepExecutor` accepts `screenshot`: the runner takes that evidence after the verdict, so it is attached to the step as on the default path, and `screenshot: false` opts out; `vision` stays `UNSUPPORTED_CAPABILITY` there, because the executor decides what its model sees.

- [#455](https://github.com/tester-army/e2e/pull/455) [`33044a7`](https://github.com/tester-army/e2e/commit/33044a70e785ab94c77f01fff525648891a3e8b9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A worker failure is recorded once. A target whose workers could not boot reported `WORKER_INIT_FAILED` once per worker still starting (`workers: 4` gave four), a worker's fatal error was followed by a second run error for the kill the runner itself issued, and a message to a worker whose channel had just closed could take the runner down without a report and without stopping the app it managed (`APP_ALREADY_RUNNING` on the next run). A promise a test rejects and never awaits now fails that test with the rejection's error; the rest of the file runs and the exit code is 1. Before, the worker died, the next test in the file was skipped as `infrastructure-unavailable`, and the run reported `WORKER_EXIT` with exit code 3. An unhandled rejection is charged to the test running when it surfaces; between tests it is the run error `UNHANDLED_REJECTION`, naming the last test that finished in the worker as the likely source, and it ends the worker only before any test has finished there.

## 0.15.0-canary-20260922161512

### Patch Changes

- [#419](https://github.com/tester-army/e2e/pull/419) [`707c894`](https://github.com/tester-army/e2e/commit/707c8942fd13a9f67d0212c340c662ad152971d0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The skill's `writing-tests` topic and the guide show API tests: a test that takes only `app` calls `fetch` against `app.baseUrl` and checks the response with the value matchers, with no page and no model call.

- [#422](https://github.com/tester-army/e2e/pull/422) [`b71ecc0`](https://github.com/tester-army/e2e/commit/b71ecc0f09bd49801c2f4ff27a8822de846e7c3e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A test the selection left out (a file no positional named, a tag filter, a platform it does not declare) no longer appears as skipped on the markdown page or in JUnit: `e2e run tests/regression` reported every agent test as `skipped: file not selected by a positional argument` and counted them in the headline. Each result in `report.json` now carries `selected`, the flag the summary's `selected` count and the terminal already used; the page and JUnit render only selected results, and read a document without the flag as all selected. `toBeHidden` reports `visible` as what it observed instead of the node's states.

## 0.15.0-canary-20260922135036

### Minor Changes

- [#394](https://github.com/tester-army/e2e/pull/394) [`4c93414`](https://github.com/tester-army/e2e/commit/4c934142bc4ef4002811eff2be20d463343dd381) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `createAgent` accepts `context`, with the value and meaning of `agents.<name>.context`: trusted project vocabulary prepended to every act turn and judgment of that agent. `{ executor: createAgent({ model, system, context }) }` is now a complete agent, so the options object around it needs no second `model` or `context` key. Naming a different `context` on both `createAgent` and the options object is `INVALID_CONFIG`, as it is for `model`; the same value on both is accepted. `StepExecutor` gains an optional `context` member for the same reconciliation.

- [#417](https://github.com/tester-army/e2e/pull/417) [`a577da3`](https://github.com/tester-army/e2e/commit/a577da3199c42402dfb9a04cd8452c5d89ab40dc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `EngineInitInfo` gains `log(line)`, the same progress line `prepare` and `finish` already have: the runner streams it as a `notice` run event prefixed with the target and worker slot (`ios worker 1: ...`), from a worker process and an in-process worker alike, so a fact that only exists once the worker is up (the URL a hosted browser or device can be watched at, which simulator a slot got) reaches the reporter and every host sink. Additive; the SPI version stays 1.

- [#386](https://github.com/tester-army/e2e/pull/386) [`a583a88`](https://github.com/tester-army/e2e/commit/a583a88254cd80450f986174b022cf961442e7f0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Three value matchers a Playwright or Jest test reaches for: `toHaveLength`, `toMatchObject`, and `toHaveProperty` (dotted or array path, optional value), each under `.not` and on `expect.poll`. `expect.any`, `expect.anything`, `expect.objectContaining`, `expect.arrayContaining`, `expect.stringContaining`, and `expect.stringMatching` stand in for values inside `toEqual`, `toMatchObject`, `toContain`, and `toHaveProperty`; they are Jest's matchers with Jest's rules. The unit-runner matchers (`toThrow`, `toBeInstanceOf`, `toStrictEqual`, `resolves`, `expect.extend`) stay out.
  
  `expect.soft(actual)` returns the same matchers for a locator, a `web` fixture, or a value, but keeps a failure on the attempt instead of throwing it. Once the body has settled the attempt fails with one `ASSERTION_FAILED` listing every soft failure in order; a body that throws or times out keeps its own error and records the soft failures under `secondaryErrors`. Outside a test body, in a standalone script or an `afterEach` hook, `expect.soft` throws at once like `expect`.

- [#384](https://github.com/tester-army/e2e/pull/384) [`0f864ad`](https://github.com/tester-army/e2e/commit/0f864ad3f3e7f5242ed957941e58e55e1a818aee) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `locator.pressSequentially(text, { delay?, timeout? })` types into exactly one editable node as keystrokes, so an autocomplete, a search-as-you-type box, or a masked input wired to key events reacts the way it does for a user. `fill` sets the value and fires no key events, which leaves those apps cold. The harness composes it from the engine's `focus` action and `keyboard` capability, so no engine changes; a target lacking either fails with `UNSUPPORTED_CAPABILITY` before any node resolves. `delay` sends one character per keyboard call that many milliseconds apart. A `Secret` is a type error and `INVALID_ARGUMENT` at runtime: secrets go through `fill`.

- [#413](https://github.com/tester-army/e2e/pull/413) [`2b9361f`](https://github.com/tester-army/e2e/commit/2b9361ffea8e39d2c32a5b1e2a6a98c2da759380) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The markdown page's folded test list is one table: a row per file with its counts and time, worst file first, then a row per test. The agent column appears only when the run used the agent. The GitHub comment and `summary.md` both render it.

- [#390](https://github.com/tester-army/e2e/pull/390) [`2e4d40e`](https://github.com/tester-army/e2e/commit/2e4d40eb0754f2558e5e89fe80b4b4933183d023) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run --max-failures <n>` (`RunOptions.maxFailures`) stops the run once that many tests have failed or timed out: nothing more is dispatched, the tests running end as `interrupted`, and the tests not started are skipped with the new cause `failure-limit` and the reason `run stopped after 3 failures (--max-failures 3)`; the exit code is the failures' own. Reporters get a `run-stopped` event with the count and the limit. The report schema's skip causes gain `failure-limit`.

- [#391](https://github.com/tester-army/e2e/pull/391) [`f01c01f`](https://github.com/tester-army/e2e/commit/f01c01fbe3a73f2e9380a7db2e62718517ab2e6b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run --repeat-each <n>` (`RunOptions.repeatEach`) runs every selected test that many times. Each run is a result of its own: `repeat` 0 through `n - 1` on the report result and serial group (0 on every report from now on), an `id` that stays the same for the first run and differs for the later ones, a `(repeat #n)` suffix in the list reporter, JUnit, and the failure pages, and artifacts under a `repeat-<n>` directory. Setup tests run once. Run events `test-started` and `step` carry `repeat`. `--last-failed` names a test once whichever of its repeats did not pass.

- [#387](https://github.com/tester-army/e2e/pull/387) [`d043035`](https://github.com/tester-army/e2e/commit/d04303523652b264b02af82d200f7cc726c044b3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run` and `e2e list` take three more selection flags. `--exclude-tag <tags>` leaves out every test carrying one of the tags, whatever `--tag` or a positional selected. `--grep <pattern>` keeps only the tests whose title matches a regular expression, and `--grep-invert <pattern>` leaves out the ones that match; the text matched is the describe titles and the test title joined by one space, a bare pattern or `/pattern/flags`, repeated for alternatives. `RunOptions` and `ListOptions` carry them as `excludeTags`, `grep`, and `grepInvert`. When the filters leave nothing to run, `NO_TESTS` counts the tests each one removed and names the tags and patterns.

- [#389](https://github.com/tester-army/e2e/pull/389) [`ae930bb`](https://github.com/tester-army/e2e/commit/ae930bbf9a6d3793ad9f96e0efb2e8c36cb7665a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e run` and `e2e list` take `--last-failed` and `--shard <index/total>`. `--last-failed` selects only the tests the previous run did not pass, read from the `report.json` the run overwrites: failed, timed out, interrupted, or skipped because a setup, a serial predecessor, a hook, or the worker failed; no report to read is the new `NO_LAST_RUN` error. `--shard 2/3` runs one contiguous slice of the selected tests, cut once every other filter applied, never splitting a serial group and bringing only the setup tests the slice needs. `RunOptions` and `ListOptions` carry them as `lastFailed` and `shard`.

- [#383](https://github.com/tester-army/e2e/pull/383) [`856e088`](https://github.com/tester-army/e2e/commit/856e08863442191381ef51fc251981cec01c2844) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `Role` grows by the composite widgets and structure ported Playwright tests name: `tablist`, `tabpanel`, `menu`, `menubar`, `menuitemcheckbox`, `menuitemradio`, `progressbar`, `spinbutton`, `meter`, `toolbar`, `tooltip`, `group`, `separator`, `radiogroup`, `grid`, `gridcell`, `rowgroup`, `rowheader`, `tree`, `treeitem`, `article`, `figure`, and `form`. The list stays closed. `getByRole('img')` is accepted as an alias of `image` and builds the `image` query, so engines, the trace cache, and reports never see `img`.
  
  The web engine reads `role="img"` back as `image`, and its reader derives the new roles from HTML semantics (`<progress>`, `<meter>`, `<hr>`, `<fieldset>`, `<details>`, `<input type="number">`, `<thead>`/`<tbody>`, `<th scope="row">`, `<figure>`, `<article>`, a named `<form>` or `<section>`, `<header>`/`<footer>`/`<aside>` landmarks) instead of dropping them, and names a fieldset, figure, or table by its legend, figcaption, or caption.
  
  The mobile engine maps a tab bar, a segmented control, and a `TabLayout` to `tablist`, their items to `tab` (on iOS, the buttons inside a tab bar or segmented control), a progress indicator or `ProgressBar` to `progressbar` (an activity indicator stays `status`), a stepper or `NumberPicker` to `spinbutton`, and `Toolbar`, `Menu`, `MenuItem`, and `RadioGroup` to their roles on both platforms.

### Patch Changes

- [#414](https://github.com/tester-army/e2e/pull/414) [`eb739e9`](https://github.com/tester-army/e2e/commit/eb739e930d533db36206d622c960d18a1ba965e7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A custom `StepExecutor` with a `context` member of its own is no longer read as the agent's vocabulary. Only the built-in agent's `createAgent({ context })` and the agent entry's `context` key count, and the executor contract has no `context` field.

- [#415](https://github.com/tester-army/e2e/pull/415) [`0e525a0`](https://github.com/tester-army/e2e/commit/0e525a09dd2b8287280b1ede81a06d32dcb7f1d3) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `pressSequentially` no longer sends one more character after its timeout cuts a pause. The pause capped by the deadline ends the typing by itself, instead of a clock read after the sleep that a timer firing a hair early could pass.

- [#388](https://github.com/tester-army/e2e/pull/388) [`dcfe53a`](https://github.com/tester-army/e2e/commit/dcfe53a4b0e4c70b5f9a01f980c6dffea021f8c9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A positional may end in `:line` (`npx e2e run tests/signup.e2e.ts:12`, `signup:12`) to select only the test whose `test(` call opens on that line, in every file the positional names; a serial group runs whole when a line names one member, and naming the file without a line selects it whole. When no test is declared at a named line, `NO_TESTS` names the positional and the lines the file declares tests at.

## 0.15.0-canary-20260921180210

### Minor Changes

- [#380](https://github.com/tester-army/e2e/pull/380) [`54c0dba`](https://github.com/tester-army/e2e/commit/54c0dba62fc47403564ece41ce503bb9b9ce9a08) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Coordinate input for the deterministic API. `screen.tapAt({ x, y })` taps a viewport point with no node behind it, `screen.swipe({ from, to })` swipes along a path between two points (a touch swipe on a device, a pointer drag on a document platform), and `tap({ position })` on a locator (also `click`) taps at an offset of the node's box, scrolling it into view first when the engine can. Points are CSS pixels, the space `boundingBox()` reports in; a negative or non-finite coordinate is `INVALID_ARGUMENT`, and an engine without the matching pointer action is `UNSUPPORTED_CAPABILITY` before anything is resolved. Engine contract: a new `swipeTo` pointer action kind (`{ kind: 'swipeTo', target }`) carries the path swipe, and `TargetSession` exposes `pointerActions`. `Point`, `TapOptions`, and `SwipePathOptions` are exported.

- [#365](https://github.com/tester-army/e2e/pull/365) [`f7f86d9`](https://github.com/tester-army/e2e/commit/f7f86d91e87b317dea9ae076f143e20f6ba8ed98) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine contract gains an optional `finish(info)` hook: once per run and target in the runner process, after the last worker of the target is gone, on every exit path (pass, failure, interrupt, a `prepare` that threw part-way), within the cleanup budget and never cancelled by an interrupt. Release what `prepare` acquired for the run there. `EnginePrepareInfo` carries `projectRoot`, so a hook can resolve a relative option before any worker exists. Additive; the SPI version stays 1.

- [#382](https://github.com/tester-army/e2e/pull/382) [`2e18196`](https://github.com/tester-army/e2e/commit/2e18196b79ac724c2a274a27562ea06d7a316d02) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The locator reads and matchers a Playwright user reaches for on day one. `locator.all()` hands back one `nth(i)` locator per current match and `locator.allTextContents()` reads every match's normalized text; both resolve once, without waiting or the exactly-one rule, and answer zero matches with `[]`. `isHidden()` is the negation of `isVisible()` and `isDisabled()` of `isEnabled()`, with the same strictness and the same `POLICY_DENIED` rules on secure fields. `expect(locator).toBeAttached()` waits for one match to exist, hidden or shown, and negated passes once nothing matches. `toHaveText` and `toContainText` take a list: the match count must equal the list length and each match must satisfy the entry at its position, a string exactly, a `RegExp` by test; the failure lists every text observed.

- [#377](https://github.com/tester-army/e2e/pull/377) [`9f2b73f`](https://github.com/tester-army/e2e/commit/9f2b73f9293d4cdee449bb04e4f8272477d22402) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Subscription sign-in ships inside `e2e`; the separate `@e2edev/oauth` package is gone. Import the model from `e2e/oauth/chatgpt`, `e2e/oauth/copilot`, or `e2e/oauth/grok` and install only the provider package it wraps (`@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/xai`). The constructors and the CLI are the whole surface; the `createOAuthFetch` library API of the old package is not carried over. `e2e init` writes those imports and no longer adds a sibling dependency, `e2e login` and `e2e logout` run the flows directly, and the `e2e-oauth` bin is retired; uninstall `@e2edev/oauth` from projects that had it. The `chatgpt()` fold for the Codex stream without a `content-type` header lands with it.
  
  `e2e models [provider]` asks the vendor which models a stored login serves and prints their ids. `chatgpt()` now tells the AI SDK that the Codex backend stores nothing server side, so a second turn carries the encrypted reasoning of the first instead of referring to it by an id the backend cannot find (`Item with id 'rs_…' not found`). The `CHATGPT_MODELS` constant is gone; the list is the vendor's.

- [#392](https://github.com/tester-army/e2e/pull/392) [`f5e96d0`](https://github.com/tester-army/e2e/commit/f5e96d0cbea6bc26da1084ea3bbc49b7a7a16dd8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The engine packages are named after what they drive, not what they are built on. `@e2edev/playwright` is now `@e2edev/web` with a `web()` factory, and `@e2edev/agent-device` is now `@e2edev/mobile` with a `mobile()` factory; the engine names in reports and telemetry follow (`web`, `mobile`). Option types rename with them (`WebOptions`, `WebConnectOptions`, `WebBasicAuth`, `MobileOptions`, `MobilePlatform`), the agent tool pack is `mobileTools` from `@e2edev/mobile/tools`, and the `device` fixture keeps its name. `PlaywrightLiveSurface` keeps its name because it hands out Playwright objects. `e2e init` writes the new packages. Replace the dependency and the import in an existing project; the old packages are deprecated on npm and receive no further releases.

## 0.15.0-canary-20260921154506

### Minor Changes

- [#351](https://github.com/tester-army/e2e/pull/351) [`45c08b1`](https://github.com/tester-army/e2e/commit/45c08b123e52369257433da2e133a84f2d6bdfa7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The built-in agent reads a phone keyboard the way the platform does. An action result says when the on-screen keyboard closed with the action, because on a touch screen the tap that closes it is often spent on closing it and the control under the finger did not react; the model is told to act on it again rather than read an unchanged screen as success. The execution rules now require the latest result to show the asked-for outcome before a passed verdict: a result reporting no change, or only the keyboard closing, means the decisive action did not land. `scroll` repeats up to 20 screens in one call instead of 5, so a long list costs turns in proportion to its length rather than five screens at a time.

- [#359](https://github.com/tester-army/e2e/pull/359) [`c1d23b2`](https://github.com/tester-army/e2e/commit/c1d23b230b8c8502f551e869710ed26f606a7469) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A recording's starting and ending screens are compared as routes, not URLs. A location is reduced to its pathname with every segment that looks minted per record abstracted: uuids, hex and digit runs, long tokens mixing letters and digits, text with spaces. The query, the fragment, and a trailing slash are ignored; an app that routes in the fragment (`/#/companies/1`) routes by that path. A value the call marked with `unique()` is recognized in the slug an app derives for a record path, next to its percent- and form-encoded spellings. At the end of a step, two locations that still differ in one segment, a slug of a record the runner never saw, are the same screen when the recorded anchors are on it. The replay policy version changes, so existing caches start over.

- [#369](https://github.com/tester-army/e2e/pull/369) [`d746ce4`](https://github.com/tester-army/e2e/commit/d746ce4b3f568c00ac736c116a561ef4e4dc67df) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Telemetry tells a fleet from its users: a platform that runs e2e on someone's behalf sets `E2E_TELEMETRY_FLEET=<name>` and its fresh machines are attributed to `fleet:<name>`, like CI, instead of each counting as a new user. Every event also carries the sandbox the kernel announces (`firecracker`), the JavaScript runtime and its version (`node`, `bun`, `deno`), whether the command created the preferences file, and the days since it was created (unknown for a preferences file from before this release). Every event also tells PostHog to skip its GeoIP step, so no location is derived from the request address, and the one-time notice shows again once because what is collected has changed.

- [#371](https://github.com/tester-army/e2e/pull/371) [`d7d843a`](https://github.com/tester-army/e2e/commit/d7d843af9d241246d225795b7d2439cb98a27a8a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The run telemetry event now names the error that decided the status (`primary_error_code`), counts attempts and the tests that needed a retry, counts the agent's actions by the runner's own names with a project's tools folded into one `tool` bucket, files an engine, provider, or plain failure under a kind from a closed list read off its message (`MODEL_PROVIDER_FAILED:rate-limit`, `ENGINE_FAILURE:device`, ...) without sending the message, and says whether the provider priced the model calls (`cost_source`).

- [#370](https://github.com/tester-army/e2e/pull/370) [`bd2a9a6`](https://github.com/tester-army/e2e/commit/bd2a9a6db7c23193be6a914f961c3fb178074d59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The session telemetry event now says how the command ended: its exit code, its duration, and the runner error code when a run or a listing failed before it could start (`CONFIG_NOT_FOUND`, `INVALID_CONFIG`, ...) or `CLI_USAGE` when the CLI rejected a flag. `e2e init` sends an init event with how it ended and the ids of the engine, the gateway, the skill, the MCP registration, and the install chosen; never a path or an endpoint typed at a prompt.

- [#354](https://github.com/tester-army/e2e/pull/354) [`91dcd30`](https://github.com/tester-army/e2e/commit/91dcd30b535331d89d197f6c5f3e8ae984e92960) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Consecutive identical scrolls fold into one recorded action with a repeat count, so a list paged to its end no longer overruns the action cap and poisons the trace; replay repeats them with a settled look between, re-finding the list each time. A scroll target a device renamed and renumbered is re-found live by its role and place, and a lost list that covered at least half the viewport when recorded (`spans` on the recorded scroll) scrolls as the viewport, live and on replay; a smaller region hands off.

- [#355](https://github.com/tester-army/e2e/pull/355) [`ddf9747`](https://github.com/tester-army/e2e/commit/ddf97479d734b294f826b01b206e3b49cb7822bf) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A recorded point tap whose containing node matches several look-alikes taps the one the recorded point lies inside, on a viewport of the recorded size; a node that is gone hands off as before, and the bare point is never tapped on its own. The replay policy version moves to `conservative/5`, so entries recorded under the previous rules are re-recorded rather than replayed under the new ones.

- [#353](https://github.com/tester-army/e2e/pull/353) [`9fbba0b`](https://github.com/tester-army/e2e/commit/9fbba0b34c4f6a387d62914d35fc756b84ba7f8e) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A typed value is recorded as a run-time gap only when the step read it off a screen it saw (a code, a reference the app minted; a field echoing what was typed does not count) or when it is a date or time, or when the model had been shown a screenshot in that step, where a value may have been read off pixels the runner cannot check. A value the model composed itself, a name or an email for a form, is the flow's data and replays verbatim, where before any value absent from the instruction and params ended the replay.

### Patch Changes

- [#373](https://github.com/tester-army/e2e/pull/373) [`ca5e619`](https://github.com/tester-army/e2e/commit/ca5e6196b620165dcabc383c1aaf35c44cf22690) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Relicense from MIT to Apache-2.0. The package ships the license text and a `NOTICE` file.

- [#344](https://github.com/tester-army/e2e/pull/344) [`d438348`](https://github.com/tester-army/e2e/commit/d438348fda96a512cc03b51c41f1140353030003) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A `unique()` value is templated in a recording in every spelling a URL gives it: as typed, percent-encoded (`Acme%20Corp` in a path), and form-encoded (`Acme+Corp` in a search query). A step that ends on a search result or on a page whose path carries the value replays and passes its end check with the next run's value; before, the encoded form stayed literal and the step handed off after replaying every action.

- [#345](https://github.com/tester-army/e2e/pull/345) [`b9abd60`](https://github.com/tester-army/e2e/commit/b9abd60c435935fc96816249f48315885d8ac85f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A control with no accessible name, text, placeholder, or test id, an unlabelled input in a form, is now recorded with its place among the unnamed controls of its kind and relocates by it on replay. It is matched strictly, so an unnamed textbox never stands in for a named one, and a change in the number of unnamed twins diverges as before. Such targets used to be unrelocatable outright, so every replay through an unlabelled form stopped at its first field.

- [#342](https://github.com/tester-army/e2e/pull/342) [`ea27708`](https://github.com/tester-army/e2e/commit/ea2770804fe55857d105224355eef7b45453d665) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A recording replays on the page it began on up to the ids the app mints per record. A step that edits or deletes a record a previous step created starts on `/companies/<id>`, and that id is new on every run; the start check compared it literally and missed with `wrong-context` every time. It now uses the same shape comparison as the end-of-step check.

- [#343](https://github.com/tester-army/e2e/pull/343) [`195bd0d`](https://github.com/tester-army/e2e/commit/195bd0d14cc3f32440bfa140ed468dfa705d851d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replays hand off sooner, and less often, on list pages. Pagination ranges (`Showing 1 to 9 of 9 results`), record counts (`12 items`), millisecond timings, and bare numbers such as a badge are no longer recorded as end anchors while a stable anchor exists: they grow with the data every run leaves behind and could never read the same again. A recording's end wait is now measured from its last action to the passing screen instead of from the step's start, so a replay no longer waits out the model's thinking time before handing off.

- [#368](https://github.com/tester-army/e2e/pull/368) [`da6b939`](https://github.com/tester-army/e2e/commit/da6b939e4c306b5dba64088599961a666f680c9a) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - Use consistent sentence case for `e2e init` prompts and status messages.

- [#366](https://github.com/tester-army/e2e/pull/366) [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list reporter's live block now reaches the bottom of the terminal: the running tests take the rows under the log and the summary sits on the last rows, instead of the block stopping fourteen rows in and leaving the lower half of a tall terminal blank. The block gives rows back to the log as results print, and only once the log has grown down to the rows the running area needs does it scroll the log, as before.

- [#346](https://github.com/tester-army/e2e/pull/346) [`f09b69e`](https://github.com/tester-army/e2e/commit/f09b69e90a8f76172ba5e5e006e7ec10dd99c172) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Clarify the bundled setup guide for subscriptions, API keys, and local models. Correct model authentication, judge selection, locator waiting, and cache guidance.

- [#375](https://github.com/tester-army/e2e/pull/375) [`f3d61e8`](https://github.com/tester-army/e2e/commit/f3d61e8ce7a8ab9a40090ecd72c9f43557a12492) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A step call without `await` fails the test instead of the worker. A body that returned while a step it started was still running used to end the attempt under that step; the step then failed with nobody to catch it, and the unhandled rejection took the worker down as `WORKER_CRASH`. The runner now checks for running steps whenever the body settles, cancels them, and fails the attempt with `STEP_NOT_AWAITED`, the step recorded as failed and the code frame at the call that lacks `await`. A body that threw keeps its own error; the un-awaited step is recorded under `secondaryErrors`.

- [#366](https://github.com/tester-army/e2e/pull/366) [`fb6e336`](https://github.com/tester-army/e2e/commit/fb6e3363275991bf2baa3698f03a69574d93cb83) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `console.log` and `console.error` in a test reach the terminal again. Workers wrote them straight into the runner's terminal, where the live window painted over them and left stale rows behind; the worker now sends each write to the runner as an `output` run event, and the list reporter prints it above the live window under a `stdout | target file > test` heading, one heading per source until another line intervenes. A line written in pieces prints once whole, and every secret value the worker has seen is redacted before the text leaves it. Programmatic reporters receive the same event with the test id, agent, target, and stream.

- [#367](https://github.com/tester-army/e2e/pull/367) [`e9c2914`](https://github.com/tester-army/e2e/commit/e9c2914c6d8f8d664d820b13a1fa454e9247e94b) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - Fix documentation links in CLI help, the init cache hint, and telemetry output to use https://e2e.tester.army/docs. The old domain redirects page links to paths that return 404.

## 0.15.0-canary-20260917213813

### Minor Changes

- [#335](https://github.com/tester-army/e2e/pull/335) [`15081f3`](https://github.com/tester-army/e2e/commit/15081f306837ebe1040fbcb2e63bd2efe283faaa) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Sign in with a personal subscription instead of an API key. The new `@e2edev/oauth` package runs the OAuth flows for ChatGPT Plus/Pro (the Codex sign-in, browser or device code), GitHub Copilot (the GitHub CLI's login or a device flow for your OAuth App), and SuperGrok / X Premium+ (device code), stores the tokens in `~/.config/e2e/oauth.json`, refreshes them ahead of expiry, and exposes each plan as an AI SDK model: `chatgpt('gpt-5.5')`, `copilot('claude-sonnet-5')`, `grok('grok-4')`. The e2e CLI gains `e2e login <provider>` and `e2e logout`, and `e2e init` offers the three subscriptions next to the gateways.

- [#325](https://github.com/tester-army/e2e/pull/325) [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Four fixes from a real suite's first day:
  
  - `e2e run login.e2e.ts` now runs the setup test that produces the session `login.e2e.ts` consumes, wherever that setup lives. Every discovered file is collected; positionals narrow which tests run, and tests in the other files are report-only unselected results. A collection error in any file fails the run, whichever files were named.
  - `test.skip(condition, reason)` inside a test body skips the running test for a fact only the app can tell. The steps that ran stay in the report, teardown runs, no retry is spent, and the result is `skipped` with the reason. A setup test cannot skip (`INVALID_ARGUMENT`); outside a body the form is `COLLECTION_ERROR`. Report schema: a skipped attempt may carry steps and a `skip` reason.
  - `expect(actual, message)` opens a value failure with the caller's label. `toBeGreaterThanOrEqual`, `toBeLessThanOrEqual`, and `toBeCloseTo(expected, digits = 2)` join the value matchers and `expect.poll`.
  - `unique(value)` marks an `act` param that is different on every run, a timestamped name or a fresh email, so it no longer defeats the trace cache. The model sees the string as given. The recording keeps a placeholder wherever the value appeared (typed text, target names, end anchors, summaries, paths), the key digests the placeholder instead of the value, and the next run's value fills the slot at replay. Unmarked params stay literal.

- [#333](https://github.com/tester-army/e2e/pull/333) [`95b3d7f`](https://github.com/tester-army/e2e/commit/95b3d7f41946bdf35d5865d9619e92f16e625866) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Tags travel with a test past selection. Registration derives them once (the describe chain's, outermost first, then the test's own, each once), the identity that crosses to workers and into results carries them, and everything downstream reads that one list: `e2e list` prints each tag after the target (`tests/a.e2e.ts › signs in [web] #smoke`), `--reporter json` gives every pair a `tags` array, and `run.results[]` in the report carry `tags` (`[]` when none), so a reporter can group results by tag. Report schema: a result gains an optional `tags` array of distinct names as the `tags` option defines them (none blank, no comma, no leading or trailing whitespace).

### Patch Changes

- [#330](https://github.com/tester-army/e2e/pull/330) [`ba8d9ba`](https://github.com/tester-army/e2e/commit/ba8d9ba81de2879cbf216afaba0a0fe2a638cf11) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A config `tests` glob spelled in a form the grammar lacks is `INVALID_GLOB` with a hint instead of a pattern that matches nothing: braces, character classes (`[jt]s`), extglobs, a backslash separator, an absolute path, a `..` segment, or a trailing `/` or `.`. A leading `./`, a `.` segment, and a doubled `/` are dropped, so `./tests/**/*.e2e.ts` selects what `tests/**/*.e2e.ts` does, no longer walks `.git` and `.e2e` looking for it, and no longer reports "create tests/example.e2e.ts" beside the files it missed. A positional with braces, brackets, or an extglob gets the same hint instead of being taken for a file name, while an existing file or directory is selected by its path whatever its name is spelled with; positionals already resolved `./`, `..`, a trailing `/`, and absolute paths inside the project. A glob can no longer name a file whose own name contains braces or brackets.

- [#334](https://github.com/tester-army/e2e/pull/334) [`b558e78`](https://github.com/tester-army/e2e/commit/b558e78ba3b21cb86b20cc26bdd18aea08aa8a17) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Test discovery enters only the directories a `tests` glob can still match a file beneath. `tests/**/*.e2e.ts` lists the project root, reads `tests/` and its subdirectories, and nothing else, where every run and `e2e list` used to read every directory but `node_modules` (`apps/`, `build/`, `coverage/`, and the rest) and filter afterwards. A dot directory is entered only when a glob segment written with a leading dot matches it. Matching and the walk share one matcher, which carries each glob's state down the tree instead of matching every directory from the root. Symlinks are not followed, which was already so and is now documented.

- [#332](https://github.com/tester-army/e2e/pull/332) [`ed3999e`](https://github.com/tester-army/e2e/commit/ed3999e8931693f02a1a6e1737315fcea60f341b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The list-valued selection flags share one parser. `--tag`, `--target`, and `--agent` each take a comma-separated list or repeats, each name once, and an empty value (`--tag ''`, or `--tag "$TAGS"` with the variable unset) is a usage error, exit 2. Before, `--tag smoke,billing` looked for one tag literally named that, `--tag ''` failed later as `NO_TESTS` over an empty tag name, and an empty `--target` or `--agent` silently selected every target or the default agents; `--target` now accumulates on repeat as `--agent` did. When a tag filter leaves nothing to run, `NO_TESTS` blames the filter only for the tests it filtered (a test a positional or `.only` left out is counted as such), reads correctly under `--tag-mode all` ("do not carry all of the tags"), and marks each tag no test declares with the nearest declared one: `smok (did you mean smoke?)`. A tag name containing a comma cannot be selected this way; tag validation rejects one at registration.

- [#331](https://github.com/tester-army/e2e/pull/331) [`99f9ea8`](https://github.com/tester-army/e2e/commit/99f9ea81cf3d40d4eb7966b9a98cdea9c2df1745) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Malformed selection input fails where it is written, with the file named:
  
  - `tags` must be a list of distinct names, none blank, with no comma and no leading or trailing whitespace, so that `--tag` can spell every one back (inner spaces are fine, quoted). Checked at registration, like `timeout`, `retries`, and `agent`; the `COLLECTION_ERROR` names the test file. A bare string such as `tags: 'smoke'` was read letter by letter, so `--tag smoke` never selected the test.
  - `tests` in the config must be a glob or a list of globs, checked and compiled when the config resolves. A wrong type was a raw TypeError reported as a test failure with exit 1 (at config load for `tests: 5`, at collection for `tests: [1]`); it is `INVALID_CONFIG`, exit 2. A malformed glob was `INVALID_GLOB` only once a run or `e2e list` collected; it is now raised when the config loads, so `e2e explore`, `e2e mcp`, and `e2e cache` refuse a config no run could use.

## 0.15.0-canary-20260917081546

### Minor Changes

- [#323](https://github.com/tester-army/e2e/pull/323) [`0a4b7f4`](https://github.com/tester-army/e2e/commit/0a4b7f4fe9f3b316907ce896d21153a918f853e8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: `agent.act` takes no `vision` option and `agents.<name>.vision` is gone. The act model always works from the semantic tree and asks for pixels itself: it calls `screenshot` when the tree lacks what it needs, and from then on every action result carries a fresh screenshot and the point verbs (`tap_at`, `type_at`, `press_at`, `select_at`) act at points in it. There is no pixels-only mode and no screenshot-on-every-turn mode; the model decides, not the config. `vision` on `act` fails with `UNSUPPORTED_CAPABILITY`, and `agents.<name>.vision` is an unknown config key. `vision` stays on the judgments (`assert`, `waitFor`, `extract`) with `false` as the only default.
  
  For executors: `ctx.vision` is removed from `StepExecutorContext`; `observe({ pixels: true })` is the one way to ask for pixels, and a custom executor's `agent.assert` rejects `vision` like it rejects `screenshot`.

- [#314](https://github.com/tester-army/e2e/pull/314) [`0b513d9`](https://github.com/tester-army/e2e/commit/0b513d989e7086bd3998fd0d105dbea0fdd5d004) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The built-in agent's default vocabulary gains the point-addressed fallback verbs next to `screenshot` and `tap_at`: `type_at`, `press_at`, and `select_at`, each taking a point in the latest screenshot for a target the tree does not list. Every point is hit-tested against the tree the runner still holds, so a listed control is acted on by id underneath, recorded with a descriptor and replayed from the trace cache like any other action. The rules tell the model to act by id whenever the screen lists the target and to take a screenshot before naming a point; before any screenshot the point verbs answer with that reminder and spend nothing. Once a secret has been filled in the attempt, all five pixel verbs leave the vocabulary together. `waitFor` skips judgments while the screen is unchanged, comparing the pixels along with the tree when they are sent.
  
  For executors: `ctx.actions.hitTest(point)` resolves a point onto the listed control and node under it without acting.
  
  Engines gain a `keyboard` capability (`keyboard.type`, `keyboard.press`, optional `keyboard.dismiss`): input to whatever holds focus, with no node behind it. The agent's `type` and `press` accept no target on such an engine, `type_at` and `press_at` fall back to tapping the point and typing through the keyboard when the tree lists nothing there, and `dismiss_keyboard` is offered where the engine can hide an on-screen keyboard. That is how a field drawn on a canvas, or one a platform flattens out of its accessibility tree, gets its text. Executors get `ctx.actions.typeText`, `pressKey`, and `dismissKeyboard`; the trace cache records and replays them as free actions.

- [#303](https://github.com/tester-army/e2e/pull/303) [`1c9cc16`](https://github.com/tester-army/e2e/commit/1c9cc16697cb82c0a6db924f6c0f389886b2a468) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `agents.<name>.timeout` is the judgment budget: the deadline of one `assert`, `waitFor`, or `extract` call, 30 s by default. Until now that deadline was `max(30000, actionTimeout)`, so a project with a slow judge had to inflate the engine's per-operation budget to buy the model time, and every navigation and actionability wait inherited the inflated number. `actionTimeout` bounds engine operations only. A suite that raised `actionTimeout` for the judge should move the value to the agent; one that raised it for a slow page keeps it.

- [#324](https://github.com/tester-army/e2e/pull/324) [`7fcb925`](https://github.com/tester-army/e2e/commit/7fcb925d76f41f1a8558abaa57a60de4ff365868) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the engine contract's pointer side is a vocabulary, not one verb, and the vocabulary is finished before the contract locks.
  
  - `Engine.tapAt(point)` is `Engine.performAt(point, action)` with a required `pointerActions` list, mirroring `perform` and `actions`. `PointerAction` is the pointer subset of the action kinds: `tap`, `doubleTap`, `secondaryTap`, `longPress`, `hover`, `dragTo` (to a second point), and `swipe` (from the point). The harness routes a point action only for a declared kind; the agent's `tap_at` verb needs the `tap` kind in `actions` or `pointerActions`. `POINTER_ACTION_KINDS`, `PointerAction`, and `PointerActionKind` are exported from `e2e/engine`.
  - `secondaryTap` joins the action kinds and `Locator.secondaryTap()` performs it: a right click, a two-finger tap.
  - `SemanticNode.states` gains `pressed` and `SemanticNode` gains `level`; `getByRole` takes `pressed` and `level`, so a toggle button and a heading level are queries on every engine.
  - `EngineSnapshot.viewport` is `{ width, height }`: the `scale` it carried meant nothing (every engine reported 1 and nothing read it); `ObservationPixels.scale` remains the image-to-CSS ratio.
  - `ScrollDirection`, `Momentum`, and `SelectOption` are defined by the contract (`e2e/engine`) and re-exported by `e2e`, so the SPI owns its own vocabulary.
  - The `Platform` type is gone: a platform is a `string` label (`web`, `ios`, `android`, or an engine's own) on `Engine.platform`, `Target.platform`, the `platform` fixture, and `platforms`. Nothing in the harness branched on the three names, so the type only pretended to.
  
  `spiVersion` stays `1`.

- [#317](https://github.com/tester-army/e2e/pull/317) [`2e593df`](https://github.com/tester-army/e2e/commit/2e593dfb46dc71bc1785cb0ce80c35e34c0f1a90) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Recover semantic-capture timeouts with fresh, independently masked screenshots.
  The engine contract distinguishes unavailable semantics from a valid empty
  tree. Judgments obey their vision options, and every capture respects secret
  taint. The runner retires stale references and disables trace reuse for
  affected steps. Playwright supports
  the fallback; device captures still fail closed when accessibility data
  cannot establish screenshot masks.
  
  Playwright bounds the complete semantic capture and reserves node IDs before
  the reader starts. An abandoned capture cannot reuse IDs or publish late
  references. Pixel-only evidence resets the agent's semantic screen comparison
  and stops cache probes without discarding the recovered screenshot.
  
  Reports accept judgment steps that fail before a model call without inventing
  an observation revision or verdict explanation.

- [#311](https://github.com/tester-army/e2e/pull/311) [`3524a59`](https://github.com/tester-army/e2e/commit/3524a59290da01a1adf28d83272eb5ecf0219c40) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The live line under a running agent step now says what the step waits on.
  `Observing` while the screen is being read, `Acting` while an action lands,
  `Thinking` only while the model has the turn, `Replaying` while the trace
  cache runs recorded actions. On a device a snapshot or a tap takes seconds,
  and those read as model time before. Step progress carries the new signal as
  `{ phase: 'activity', activity: 'observe' | 'action' | 'model' }`, announced
  as each phase begins; the `event` that follows ends it.

- [#310](https://github.com/tester-army/e2e/pull/310) [`4c76360`](https://github.com/tester-army/e2e/commit/4c76360cb65b20c5193240b0e5a0489bd7e0c558) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The markdown page (`renderMarkdownReport`, the `markdown` reporter's `summary.md`, the pull request comment) is laid out for the reader who skims it. A green run is the headline, the folds, and one line of small print: the file table is gone, and each file's counts, agent work, and time sit on its heading inside the folded test list. Flaky tests no longer get a full block in the open; they are folded under one summary, since the run is green and the headline already counts them. A failure block is short paragraphs instead of five lines glued with hard breaks: the title; one lead naming the error and the step it happened at; what the error and the agent said, quoted; the facts as a list (expected, observed, whether every attempt failed alike, the last turns one per line, the screen); and the source link with the evidence. It names the file once, in the source link; a locator step's label reads as code and an agent step's as the sentence the author wrote; the steps before the failed one are not retold, since the lead says where in the flow it was and the trace has the rest; an assertion whose message only says its api failed quotes nothing; and a loopback screen URL shows as its path, since nobody reading the page can open it. The footer is one line with the version, duration, targets, and the run artifacts link. `MarkdownReportOptions.title` names the page in its headline (`e2e regression: 77 passed`) so two pages on one pull request read apart.

- [#306](https://github.com/tester-army/e2e/pull/306) [`17283c8`](https://github.com/tester-army/e2e/commit/17283c86dabad63631064d817196ae728c3a6136) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `EngineSnapshot` gains an optional `truncated` flag for an engine whose tree
  leaves out nodes that are on the surface. The runner merges it with its own
  byte-budget cut: the model sees a marker at the end of the listing and is told
  nodes past it are on screen but not listed, a truncated screen is never
  reported unchanged between observations, and the failure evidence header
  marks the listing truncated whichever limit cut it.

- [#325](https://github.com/tester-army/e2e/pull/325) [`d3afa6b`](https://github.com/tester-army/e2e/commit/d3afa6bacb9a407d0bd85c9f8abb2135b1d8a2ac) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Three fixes from a real suite's first day:
  
  - `e2e run login.e2e.ts` now runs the setup test that produces the session `login.e2e.ts` consumes, wherever that setup lives. Every discovered file is collected; positionals narrow which tests run, and tests in the other files are report-only unselected results. A collection error in any file fails the run, whichever files were named.
  - `test.skip(condition, reason)` inside a test body skips the running test for a fact only the app can tell. The steps that ran stay in the report, teardown runs, no retry is spent, and the result is `skipped` with the reason. A setup test cannot skip (`INVALID_ARGUMENT`); outside a body the form is `COLLECTION_ERROR`. Report schema: a skipped attempt may carry steps and a `skip` reason.
  - `expect(actual, message)` opens a value failure with the caller's label. `toBeGreaterThanOrEqual`, `toBeLessThanOrEqual`, and `toBeCloseTo(expected, digits = 2)` join the value matchers and `expect.poll`.

### Patch Changes

- [#308](https://github.com/tester-army/e2e/pull/308) [`9c835ba`](https://github.com/tester-army/e2e/commit/9c835ba64e866a8e87c1bcddc04376939edca74c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI links to the docs at https://docs.e2e.army in `--help`, the `e2e init` cache hint, and the telemetry notice. The Mintlify preview address it linked before is gone.

- [#315](https://github.com/tester-army/e2e/pull/315) [`9249de2`](https://github.com/tester-army/e2e/commit/9249de20eea96fccc5b24e3747f36708eaf8edb8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Keep exploration blocked when every charter was blocked and no issue was reported. Preserve the first blocker's error code and explanation instead of reporting a successful run.

- [#316](https://github.com/tester-army/e2e/pull/316) [`6016083`](https://github.com/tester-army/e2e/commit/60160830154972d31e81b10ddc90f6c63776a470) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Include report attempt and step identity on every live step phase so reporters can distinguish retries and nested steps. End phases also carry the redacted step error and explanation, including blocked and cancelled outcomes.

## 0.15.0-canary-20260914134810

### Minor Changes

- [#299](https://github.com/tester-army/e2e/pull/299) [`5908a10`](https://github.com/tester-army/e2e/commit/5908a107f97d6f3845ed75c5676cc514b6f03dcd) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A failure now hands off what the screen held, not only what was asked. When
  an attempt fails with the session still open, the runner looks once more and
  records the evidence on the attempt as `failure`: the location, the redacted
  screen as the agent reads it (a `log` artifact, `failure/screen.txt`), a
  masked screenshot when the run keeps screenshots and no secret was filled,
  and for a locator that matched nothing or too much, the nodes on screen
  closest to what it asked for. Every step records the test line it was called
  from as its `source`, and an error carries the line it unwound through as
  `source` too, so a report reader no longer needs the terminal's code frame.
  Errors carry structured `details` beside the message: an `expect` failure's
  `locator`, `expected`, `observed`, and `matches`; a locator failure's
  `locator`, `role`, `name` or `testId`, and `waitedMs`. An agent step records
  its last model turns as `turns`, each turn's tool calls and what came back,
  clipped, whatever the debug setting; the full transcript stays behind
  `--debug`. The `markdown` reporter renders all of it: the failure block gains
  the expected and observed facts, what the locator asked for, whether every
  attempt failed the same way, the last turns of a failed agent step, the
  screen's location and the closest nodes, one evidence path per kind, and a
  link to the test's own page under `.e2e/failures/`, one page per failed or
  flaky test with every step, every kept turn, and the screen text inline. The
  list reporter prints the location, the closest nodes, and the screen text's
  path under each failure. Report-1 gains the optional `error.details`,
  `error.source`, `attempt.failure`, and `step.turns` fields; `step.source` is
  no longer always `unknown`.

## 0.15.0-canary-20260914095510

### Patch Changes

- [#296](https://github.com/tester-army/e2e/pull/296) [`f2f2e6f`](https://github.com/tester-army/e2e/commit/f2f2e6fb1024ffb4cd481f7ea571c2d29be6d6d8) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The CLI starts without the optional `ai` peer dependency. The MCP bridge imported `asSchema` from `ai` statically and every command loads that module, so `npx e2e --help`, and `e2e init` in a project that has not installed `ai` yet, crashed with `ERR_MODULE_NOT_FOUND` before reading a flag. The bridge now reaches the SDK through the same lazy loader as the agent, and an MCP session opened in a project without `ai` reports `MODEL_UNAVAILABLE` instead.

- [#298](https://github.com/tester-army/e2e/pull/298) [`ec3b6a1`](https://github.com/tester-army/e2e/commit/ec3b6a145a9e1a58bc70227ba4e868d7c9e3c3e5) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` no longer writes `agent-device` next to `@e2edev/mobile`, since the engine installs it. A project that already declares `agent-device` keeps it.

## 0.15.0-canary-20260914081513

### Minor Changes

- [#291](https://github.com/tester-army/e2e/pull/291) [`abf1958`](https://github.com/tester-army/e2e/commit/abf19588677070fb86234f735614c40b7677e755) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Breaking: the engine contract (`e2e/engine`) is reshaped as the locked, UI-only, cross-platform SPI for 1.0. What breaks and what replaces it:
  
  - `EngineSnapshot.nodes` is `root`, one engine-minted node with an id that stays stable across observations; `url` is `location`, an opaque address (a URL on the web, the foreground screen on a device) the harness treats as a URL only when it parses as one; `viewport` is required.
  - `Engine.url()` is gone; read `location` off an observation. `Engine.swipe` is gone; the viewport swipe is `perform(root, { kind: 'swipe' })`.
  - `Engine.actions` lists the action kinds `perform` honors and is required with it. The agent's tools and the `screen` methods derive from it, so a surface is never offered a verb it cannot do.
  - `Engine.app` is data only. The hooks move to `Engine.session: { open, back, restart, reset }` (were `app.navigate`, `back`, `restart`, `clearState`). `restart` and `reset` open nothing on an addressable surface; the harness reopens the app through `open`.
  - `EngineInitInfo.testIdAttribute` and `EngineInitInfo.app.baseUrl` are gone. `SemanticNode.testId` carries the node's test id and the `testId` query resolves against it. The root config key `screen.testIdAttribute` is rejected; set `web({ testIdAttribute })` instead.
  - `press` keys follow one grammar in Playwright spelling (`Control+a`, `Shift+Tab`, `Enter`, one printable character); `parseKey`, `KEY_NAMES`, `KEY_MODIFIERS`, and `LOCATOR_ACTION_KINDS` are exported for engines. An invalid key fails with `INVALID_ARGUMENT` before it reaches an engine.
  - `OperationContext.origin` is required. `EnginePrepareInfo.env` is a plain readonly record, and `EnginePrepareResult.env` is the typed channel from a runner-side `prepare` to each worker's `init`, which reads it as `EngineInitInfo.env` (the run's environment plus that target's additions; other targets never see them).
  - Report: the target record no longer carries `testIdAttribute`; artifact kinds and usage counters are unchanged.
  
  `spiVersion` stays `1`.

- [#288](https://github.com/tester-army/e2e/pull/288) [`aa3b05b`](https://github.com/tester-army/e2e/commit/aa3b05bbbdd4534ef111e51b950002513998076f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Judgments are independent of the act loop. `agent.assert`, `agent.waitFor`,
  and `agent.extract` are shown the instruction and the current screen only:
  the prior-step ledger and the acting agent's summaries no longer reach a
  judgment call, so a verdict rests on what is on screen rather than on the
  actor's account of what it did. A new `judge` slot, `agents.<name>.judge` or
  `createAgent({ judge })`, names a separate model for the judgment tier;
  unset, judgments use `model`, and a config `judge` that differs from the
  executor's is `INVALID_CONFIG`. Each judgment step's `model` in the report
  names the model that produced the verdict. `createAgent(...)` counts as the
  built-in agent here, not a custom executor: its `agent.assert` calls now go
  to the judgment tier (one judgment call, `vision` and `screenshot` allowed)
  instead of through its own `runStep`, so the judge judges them. A hand-rolled
  executor still judges its own assertions through `runStep`.
  
  The judgment protocol is `agent-judgment-2`: the model answers `holds`,
  `fails`, or `inconclusive` instead of a boolean. An inconclusive
  `agent.assert`, one where the screen did not show enough to decide either
  way, fails with the new `ASSERTION_INCONCLUSIVE` code (category test, exit 1)
  and the model's account of what was missing; it is never a pass. In
  `agent.waitFor` an inconclusive round keeps polling until the deadline. The
  `agent-judgment-1` schema and its fixtures stay in the package, marked
  deprecated, for the stability window; the runner requests `agent-judgment-2`
  only.
  
  The report records the checkout under `run.vcs`: `commit`, `branch` when
  HEAD is on one, and `dirty` when git could say. Outside git the GitHub
  Actions variables stand in; with neither, the field is absent. It is what
  joins a run's verdicts to the pull request that produced the code.

- [#292](https://github.com/tester-army/e2e/pull/292) [`d486e40`](https://github.com/tester-army/e2e/commit/d486e40e73bfe23ac70a99f7938f05db0ba4e30c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A finished model turn in the live window now appends an excerpt of the
  model's reasoning when the model produced one: `• Thinking (2.84s) (↑7.5k
  ↓18) · The modal blocks checkout; closing it first`. Runs and explorations
  alike show why the agent acted, not just that it did. The excerpt collapses
  to one line and clips to the terminal; the full reasoning stays in the AI
  trace (`--ai-trace`). The same bounded excerpt lands on the report's `model`
  step events as `reasoning` (report-1 schema), and custom executors report
  their own through `recordModelCall({ reasoning })`.

- [#290](https://github.com/tester-army/e2e/pull/290) [`799b29f`](https://github.com/tester-army/e2e/commit/799b29fbfa0444589b66bc0e59ab0b83ededf50c) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Origin allowlists are gone, everywhere. `web({ allowedOrigins })` gated typed navigation only; a click, a redirect, or a popup reached any origin regardless, so the list guarded nothing and had to be spelled out for every subdomain a sign-in flow touched. `allowedOrigins` on a credential or a secret gated where a password could be typed; a secret is only ever typed into a field the step was handed, a password only into a password field, so that gate guarded against a model mistake at the cost of configuring every flow that leaves the app's domain, a third-party sign-in included. `app.open()`, the agent's `navigate`, and `web.goto` open any http(s) URL, `file:`, `data:`, and `javascript:` stay `POLICY_DENIED`, and a secret fills wherever the test or the step directs it. `credentials` entries are `{ username, password }`; `secrets` entries are a string or a provider, the `{ value }` object form is gone. `type_secret` now works on a device target too. What still keys on the site of `url` (its registrable domain) is invisible to config: the browser engine's `headers` reach the site and no other host, and child frames off the site stay out of observations. `basicAuth` answers a challenge from any origin, as Playwright's own `httpCredentials` does. Engine contract: `EngineAppInfo.allowedOrigins` became `site?: string`, `EngineAppDeclaration` lost `allowedOrigins`, and `sameSite`/`siteOf` are exported from `e2e/engine`. `web({ allowedOrigins })` fails at config load. If a threat model ever calls for an allowlist again, it comes back as an opt-in.

- [#294](https://github.com/tester-army/e2e/pull/294) [`c2c5df7`](https://github.com/tester-army/e2e/commit/c2c5df7df94b25a8284b69dd6bc00a459b770a59) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The runner is published as `e2e`. `@e2edev/e2e` is retired and deprecated on npm; every import, config, and peer range now names `e2e` (`e2e`, `e2e/agent`, `e2e/engine`). The engines and the GitHub reporter declare their peer dependency on `e2e`, so a project on `@e2edev/e2e` must switch the runner to `e2e` when it takes these versions. The CLI keeps its `e2e` bin name.

### Patch Changes

- [#293](https://github.com/tester-army/e2e/pull/293) [`e301105`](https://github.com/tester-army/e2e/commit/e3011054080237f6141419f738a680574308765b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `init` pins an engine exactly when the runner it ships in is a prerelease. A canary engine names one runner build in its peer range, and the caret `init` wrote resolved to the newest canary of that engine, whose peer range named a different runner and failed the install.

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

- [#278](https://github.com/tester-army/e2e/pull/278) [`7a45609`](https://github.com/tester-army/e2e/commit/7a456094a8d8ebb930c073f2cfe5ffa83315bd77) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` adds `agent-device` to `devDependencies` next to `@e2edev/mobile`, which now peers on it instead of installing it. The range pins the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `agent-device` keeps its version untouched.

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

- [#272](https://github.com/tester-army/e2e/pull/272) [`dfc4feb`](https://github.com/tester-army/e2e/commit/dfc4febe46da37420643b51bb969f423800d22fe) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `e2e init` adds `playwright` to `devDependencies` next to `@e2edev/web`, which now peers on it instead of installing it. The range is the minor the engine was built and tested against, recorded at build time like the engine ranges; a project that already declares `playwright` keeps its version untouched.

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
  in `@e2edev/mobile`. No behavior changes on our side.

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

  `init` writes the engine version released alongside the CLI (`^0.7.0` for `@e2edev/web`) instead of `0.x`. Package managers resolve a range to the registry's `latest` tag whenever it satisfies, and `latest` trails the tag the runner installs from, so `0.x` fetched an old engine whose peer range rejected the runner.

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
  platform, `{ engine: web({ url }) }` is a complete target, and so is
  `{ engine: mobile({ platform: 'ios', app }) }`. A target without an engine
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
  `@e2edev/web`, `@e2edev/mobile`) on every install line, point at
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
  `web({ url, command, services, ... })`, and the device engine derives
  the identity from the app it pins (`mobile({ platform, app })`, or an
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
  targets: [{ name: 'web', platform: 'web', engine: web() }],
  // after
  targets: [{ name: 'web', platform: 'web', engine: web({ url: 'http://localhost:3000' }) }],
  ```

- [#151](https://github.com/tester-army/e2e/pull/151) [`d4489c0`](https://github.com/tester-army/e2e/commit/d4489c06be7b9b5270c29361af9830003da947bb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Removes public API that had no consumer, was deprecated, or duplicated another surface, so what remains is what the runner actually enforces.

  - `ExecutorBudgets.recordToolCall` (deprecated): use `runTool`, which reserves the action budget before the tool body runs.
  - `ToolAnnotations.replay` and `ToolAnnotations.secrets` (deprecated, never read): `defineTool` takes `{ mutates, platforms? }`.
  - `StepExecutorContext.priorSteps` and `ExecutorPriorStep`: the ledger string is the executor's prior-step context.
  - `createToolLoopExecutor` options `onConclude`, `loopGuards`, and `windDown` (and the `WindDownPolicy` / `LoopGuardThresholds` types): the chassis keeps its own loop guards and wind-down policy.
  - The `@e2edev/e2e/agent` primitives `createGrammarTools`, `createVerdictTool`, `trackModelCalls`, `conversationMemory`, `VERDICT_RULES`, `serializeLedger`, `compactSnapshotHistory`, and `formatReplayedPrefix`: `createAgent` and `createToolLoopExecutor` are the two supported layers.
  - `blockedCategoryOf` and `BlockedCategory` from the main entrypoint.
  - The legacy fixture adapter: an engine fixture factory must return the surface it declared through `context.fixture`; a plain surface is rejected with `INVALID_CONFIG`.

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rename the "backend" concept to "engine" everywhere. The authoring import is now `@e2edev/e2e/engine` (`defineEngine`, `EngineHandle`, `EngineError`, `EngineFixtureContext`, ...), a target names its engine as `engine: web()` in `e2e.config.ts`, the error code `BACKEND_FAILURE` is now `ENGINE_FAILURE`, and the `backend` provenance field in the report and session schemas is now `engine`. `@e2edev/e2e/backend`, `defineBackend`, `backend:` and `BACKEND_FAILURE` are gone; update the import path, the config key, and any code matching on the error code or reading provenance.

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
  app opened fresh per attempt, so `mobile({ platform: 'ios', appPath:
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

- [#114](https://github.com/tester-army/e2e/pull/114) [`e19b826`](https://github.com/tester-army/e2e/commit/e19b826a7f2a944122099851803f6961f107cf86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/web` and `@e2edev/mobile`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.

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
    `Dialog`, and `WebExpectation` moved out of `e2e` into `@e2edev/web`.
    `expect(fixture)` routes to whatever expectation surface a backend attaches
    through `BackendFixtureContext.expectable`. Every `web` method call,
    including `url()`, `title()`, and `cookies()`, is now a recorded step.
  - Reports and session envelopes record `backend: { name, version, spiVersion }`
    instead of `driver`, drop `browser`/`browserVersion`/`viewport` from target
    provenance, and step events use kind `backend` (spec `suiteVersion` 0.6.0).

  Added:

  - `@e2edev/web` exports `web(options)`: a `defineBackend` handle
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
  import { web } from "@e2edev/web";

  export default defineConfig({
    targets: [
      {
        name: "web",
        platform: "web",
        backend: web({ browser: "chromium" }),
      },
    ],
  });
  ```

  A backend written against the earlier `@e2edev/e2e/backend` draft moves its `actions`
  verbs onto `perform` (switch on `action.kind`), its viewport `scroll` onto
  `swipe`, its `navigate`/`back` under `app`, declares `version`, and accepts
  the cleanup context on `endAttempt`/`dispose`.

- [#20](https://github.com/tester-army/e2e/pull/20) [`1e21658`](https://github.com/tester-army/e2e/commit/1e21658c949900be0191221a468647e43b6ddf2a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move the Playwright driver into its own `@e2edev/web` package.

  `e2e` no longer depends on `playwright`, so installs that drive another backend
  no longer download a browser. `driver: 'playwright'` still works and is still
  the default for web targets; the runner now loads the driver from
  `@e2edev/web`, which it declares as an optional peer dependency.

  **Upgrading:** install the driver alongside the runner.

  ```bash
  npm install --save-dev @e2edev/e2e @e2edev/web
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
    `@e2edev/web` instead.

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

  One observation gap closes alongside it in `@e2edev/web`: **open shadow
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
  `@e2edev/web` whenever a project ends up with more than one copy of
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
