# @e2edev/e2e

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
