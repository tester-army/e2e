# @e2edev/agent-device

## 0.5.0

### Minor Changes

- [#241](https://github.com/tester-army/e2e/pull/241) [`5ccfa46`](https://github.com/tester-army/e2e/commit/5ccfa46308bcd0160f01227da91dfc1e5f1be0b7) Thanks [@okwasniewski](https://github.com/okwasniewski)! - With no `device`, the pool is every booted device of the platform: `prepare` lists the inventory, boots as many as the run has slots, reports the count as the target's worker cap, and hands the devices to the workers through the run environment. Four booted simulators run a target's files four at a time with no config, instead of failing with "Multiple booted iOS simulators have the app installed". A `device` entry that is a simulator UDID is selected as `udid`, as the docs always said.

## 0.4.0

### Minor Changes

- [#233](https://github.com/tester-army/e2e/pull/233) [`a659f5f`](https://github.com/tester-army/e2e/commit/a659f5f5fcfc0fa97b5b460fa595d8bbf558cd0a) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Video recording. With `artifacts: ['video']` or `--video`, the engine records the device screen through agent-device's recorder into `video/video.mp4` under the attempt's artifact directory, taps shown.

- [#232](https://github.com/tester-army/e2e/pull/232) [`25e1897`](https://github.com/tester-army/e2e/commit/25e1897fbbae245814b6622faf04fb29e8d59f9d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `device` accepts a list. The engine declares one worker per device (one for a single or unnamed device), so a `workers` above the pool size no longer over-subscribes it; worker slot `n` drives the `n`th entry. Every session name now carries the worker slot, `<session>-<n>` (`e2e-<target>-<n>` by default), for a single device too: a run that named its session `qa` now drives `qa-0`. Devices boot in `prepare`, one slot after another and outside `launchTimeout`, each opening the pinned `app` once so its automation runner is up before the first attempt. An empty pool is a configuration error.

- [#226](https://github.com/tester-army/e2e/pull/226) [`adbc92c`](https://github.com/tester-army/e2e/commit/adbc92c928c6d1d28e65773ccbe58876f4de14a4) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines declare their platform on the handle: `web` for playwright, the
  `platform` option for agent-device. A target that names them no longer has to
  repeat it. Both engines now require `@e2edev/e2e` 0.8 or newer (peer range
  `>=0.8.0 <1`): an older runner rejects `platform` as an unknown engine key,
  and could still send `states.hidden` in a role query, which these engines no
  longer read.

### Patch Changes

- [#232](https://github.com/tester-army/e2e/pull/232) [`25e1897`](https://github.com/tester-army/e2e/commit/25e1897fbbae245814b6622faf04fb29e8d59f9d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Requires `@e2edev/e2e` 0.8.0 or newer, the release that hands `init` its worker slot and `prepare` its slot count; an older core would fail every device pool at init.

- [#218](https://github.com/tester-army/e2e/pull/218) [`2e50798`](https://github.com/tester-army/e2e/commit/2e50798b3cbd4b813274a53889458eced830747d) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every optional `agentDevice()` option (`app`, `appPath`, `device`, `identity`,
  `environment`, `session`, `snapshot`) also accepts `undefined`, so a config
  passes `device: process.env.E2E_DEVICE` straight through instead of spreading
  it in conditionally. The runtime already treated a missing and an `undefined`
  value alike; only the types rejected the latter under
  `exactOptionalPropertyTypes`.

- [#227](https://github.com/tester-army/e2e/pull/227) [`7143477`](https://github.com/tester-army/e2e/commit/7143477435bf5bb59bba778932cc7ad0002ce494) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `getByText` on a device target now resolves to the innermost matching node, as in a browser. iOS reports a React Native `Text` as a host view plus a `StaticText` child with the same label, and container views inherit their children's labels, so every text query on such screens failed with `LOCATOR_AMBIGUOUS`. Ancestors whose match is echoed by a matching descendant are dropped; unrelated duplicates still fail.

- [#225](https://github.com/tester-army/e2e/pull/225) [`47be7f8`](https://github.com/tester-army/e2e/commit/47be7f867da427cfa05f999c9af32ed5fd6eb6ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - `SelectOption` on the engine contract gains a `{ value }` variant. Playwright
  selects by the option's `value` attribute; the device engine's `selectOption`
  stays `UNSUPPORTED_CAPABILITY` for every variant.

- [#223](https://github.com/tester-army/e2e/pull/223) [`68620ef`](https://github.com/tester-army/e2e/commit/68620ef7459739f89f7846decd54af1c8e5105e9) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Role queries no longer read a `hidden` state from the query: the engine
  contract dropped it. Playwright's role locator keeps its default of matching
  only nodes exposed to assistive technology; the device engine skips hidden
  nodes in role queries as it did by default.

## 0.3.2

### Patch Changes

- [#206](https://github.com/tester-army/e2e/pull/206) [`ffb3403`](https://github.com/tester-army/e2e/commit/ffb34039c319434823f586a7582cdb037220da4f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Remove temporary raw screenshots after device capture finishes, including
  captures that outlive a timeout or cancellation. Each capture owns a separate
  temporary directory, and the next attempt waits for its cleanup.

- [#194](https://github.com/tester-army/e2e/pull/194) [`d9ecd33`](https://github.com/tester-army/e2e/commit/d9ecd338d8f7c34f79395c874c2f975fe55094eb) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Both engines now require `@e2edev/e2e` 0.5.0 or newer. They import
  `@e2edev/e2e/engine`, which 0.5.0 introduced (0.4.x shipped `/backend`), so
  the old `>=0.4.0` range allowed an install whose every import failed.

## 0.3.1

### Patch Changes

- [#161](https://github.com/tester-army/e2e/pull/161) [`41612dc`](https://github.com/tester-army/e2e/commit/41612dcf44e6e395d578a23c09cf1dd451231095) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Package and CLI descriptions no longer call e2e a "standard".

- [#168](https://github.com/tester-army/e2e/pull/168) [`1ef5b00`](https://github.com/tester-army/e2e/commit/1ef5b003b62a588f554ad567f9d1f4540ffd8b35) Thanks [@devin-ai-integration](https://github.com/apps/devin-ai-integration)! - READMEs and CLI help use the scoped package names (`@e2edev/e2e`,
  `@e2edev/playwright`, `@e2edev/agent-device`) on every install line, point at
  the Fern docs instead of e2e.dev, and describe e2e as an open framework for
  agentic end-to-end testing.

## 0.3.0

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

- [#154](https://github.com/tester-army/e2e/pull/154) [`1d352b3`](https://github.com/tester-army/e2e/commit/1d352b3ee98a02d239c95e4055b4bb5219d7edfc) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Rename the "backend" concept to "engine" everywhere. The authoring import is now `@e2edev/e2e/engine` (`defineEngine`, `EngineHandle`, `EngineError`, `EngineFixtureContext`, ...), a target names its engine as `engine: playwright()` in `e2e.config.ts`, the error code `BACKEND_FAILURE` is now `ENGINE_FAILURE`, and the `backend` provenance field in the report and session schemas is now `engine`. `@e2edev/e2e/backend`, `defineBackend`, `backend:` and `BACKEND_FAILURE` are gone; update the import path, the config key, and any code matching on the error code or reading provenance.

### Patch Changes

- [#149](https://github.com/tester-army/e2e/pull/149) [`f810e23`](https://github.com/tester-army/e2e/commit/f810e2324b02b189cbbb6242a55da5d587285932) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Every `screen` query accepts `visible: true`, which drops nodes the platform reports as hidden before the exactly-one rule runs: `getByText('No memories yet', { visible: true })` resolves the copy a person sees even while a framework keeps a `display:none` twin in the document after a reload. Omitted or `false` keeps every match, so existing `LOCATOR_AMBIGUOUS` failures still fire. The predicate is the node's own `hidden` state, the one `toBeVisible()` reads, and it composes with scopes, `filter`, `first`, `last`, and `nth`. `getByTestId` gains the same optional `{ visible }` argument.

  The engine contract's `SemanticQuery` carries the flag as `visible`; the Playwright and agent-device engines evaluate it from the hidden state they already report, and the harness holds a top-level query to the same predicate as a backstop.

## 0.2.1

### Patch Changes

- [#128](https://github.com/tester-army/e2e/pull/128) [`3c24e17`](https://github.com/tester-army/e2e/commit/3c24e1714bf1862f1e2d48c10e2c649c7ce433a0) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Replace the handwritten PNG codec with pngjs while preserving opaque rectangle masking. Use the library for screenshot test fixtures and reject malformed images.

- [#132](https://github.com/tester-army/e2e/pull/132) [`bc87f15`](https://github.com/tester-army/e2e/commit/bc87f15b3b62258f8e9c059873e1f89a67ba27de) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Keep secret redaction and pixel taint with the live session across serial members. Route device model screenshots through guarded observations and reserve project-tool action budgets before dispatch, serializing mutations with grammar actions.

  Add explicit fixture operation declarations, preserve legacy factories, mark contributed assertions as verification steps, and isolate asynchronous step attribution. Share cancellation helpers; deprecate optional tool annotations whose replay and secret semantics are not implemented.

  Preserve fixture object identity and mutable state when recording declared operations, and retain artifacts and viewport metadata attached before a legacy synchronous failure.

  Bound device located references and reuse snapshot location metadata. Both reference backends require e2e >=0.4.0 for the new fixture and lifecycle helpers.

## 0.2.0

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

### Patch Changes

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

## 0.1.0

### Minor Changes

- [#102](https://github.com/tester-army/e2e/pull/102) [`e3300c4`](https://github.com/tester-army/e2e/commit/e3300c4b420ea7a5a7e3ee15480a1e38bd1a133b) Thanks [@okwasniewski](https://github.com/okwasniewski)! - New package: `@e2edev/agent-device`, the mobile backend for `e2e`, built on
  [agent-device](https://github.com/callstack/agent-device). It implements the
  public `@e2edev/e2e/backend` contract for iOS simulators and Android emulators the
  same way `@e2edev/playwright` does for browsers, and core learns nothing new.

  - `agentDevice({ platform, app?, device?, session?, snapshot? })` returns a
    `defineBackend` handle with observation (the accessibility tree projected
    onto the role vocabulary, with a viewport and optional pixels), actions
    (tap, double tap, long press, fill, clear, check, Enter, single-character
    keys, node swipe, drag), location (every `screen` query plus agent-device
    selectors through `screen.locator`), a viewport swipe, `app.back`, and
    `app.restart`/`app.clearState` when `app` is pinned. Screenshots land under
    the attempt artifact directory.
  - Trace cache support: the backend reports a location as
    `app://device/<app>/<screen title>`, so `agent.act` steps record a start and
    end anchor and replay zero-turn on the next run like a web step does.
    Screenshots and observation pixels have every secure field painted over;
    an image that cannot be redacted is withheld. With `app` pinned, the app
    is opened fresh per attempt and a flow needs no agent-side tool at all.
  - The contributed `device` fixture: network, airplane mode, permissions,
    location, appearance, orientation, biometrics, open/close app, foreground
    app, home, back, alerts, keyboard, clipboard. Import `test` from the
    package to have it typed.
  - `@e2edev/agent-device/tools` exports `agentDeviceTools(...backends)`: an
    `open_app`, `swipe`, `type_text`, `alert`, and `screenshot` pack for
    `createAgent`, scoped to the platforms of the backends passed and
    dispatching to the one whose attempt is running, so one pack serves an iOS
    and an Android target in the same config.

- [#114](https://github.com/tester-army/e2e/pull/114) [`e19b826`](https://github.com/tester-army/e2e/commit/e19b826a7f2a944122099851803f6961f107cf86) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Publish under the `@e2edev` npm scope as restricted (private) packages: the core package `e2e` is now `@e2edev/e2e`, beside `@e2edev/playwright` and `@e2edev/agent-device`. Entry points move with the name (`@e2edev/e2e/agent`, `@e2edev/e2e/backend`, `@e2edev/e2e/run`); the `e2e` CLI binary keeps its name. Provenance is off while the packages are private, since npm only attests public packages.
