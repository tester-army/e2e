# @e2edev/e2e

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
