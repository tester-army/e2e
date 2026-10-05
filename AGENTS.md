# AGENTS.md

`e2e` — an agentic end-to-end testing framework. pnpm monorepo, ESM only,
TypeScript 7.

## Contracts

There is no separate spec. The code is the contract, pinned in three places:

- The emitted `packages/e2e/dist/index.d.ts` (and `dist/engine/index.d.ts`,
  `dist/oauth/*.d.ts`)
  is the public API. `packages/e2e/tests/types/sdk-types.ts` holds compile-time
  assertions (`@ts-expect-error` lines) for the parts that are easy to loosen
  by accident; it runs under the package `typecheck`, never under vitest.
- Wire formats live in `packages/e2e/schema/*.schema.json` (report-1,
  session-1, agent-judgment-2, and the deprecated agent-judgment-1) with a valid and an invalid fixture
  each. Integration tests validate every generated report and session envelope
  against them; `tests/unit/schema-fixtures.test.ts` checks the fixtures. A
  wire change edits the schema, both fixtures, and the producer in one review.
- Security invariants are the list under Gotchas below, enforced by tests in
  `tests/integration/agent-policy.test.ts` and the secret-ledger unit tests.
- Behavior changes update the matching `docs/**/*.mdx` page in the same
  change, including "not implemented yet" callouts, and `skills/e2e/` when the
  changed surface is described there. `scripts/check-error-codes.ts` (in
  `pnpm check`) fails when an error code in source is missing from
  `reference/errors.mdx` or `reference/engine.mdx`, or documented but raised
  nowhere.

There are no RFCs or design documents in the repo. The why lives in PR
descriptions and commit bodies; `git log` and `gh pr view` are the archive.
## Layout

`packages/` holds what publishes to npm; `apps/` holds the private apps and
suites that consume the built packages the way a user would.

- `packages/e2e` — the published `e2e` package: SDK surface, runner, CLI,
  `e2e/engine` contract. Core knows the contract and never an engine's
  internals: no `Web`, `browser`, `page`, `route`, or `playwright` noun lives in
  `src/` (grep for them; zero hits is the invariant). The one exception is the
  `e2e init` scaffold presets in `src/cli/init/engines.ts`, which write the
  user's config and so name engine packages as text; the package build records
  the sibling packages' versions in `dist/cli/init/sibling-versions.json` for the
  ranges they write. Each preset owns its prompt label, dependencies, config,
  example, and run command; interactive choices derive from this list. These
  presets never import engine implementations.
  - `src/run/` runner core (scheduler, units, workers, retries, sessions;
    `standalone.ts` opens one attempt with no test body for hosts),
    `src/collect/` registration+selection, `src/locator/` locator AST/engine,
    `src/agent/` the agent (the `act` executor socket plus the judgment
    methods), `src/mcp/` the `e2e mcp` server (a live session that rides
    the `act` socket with a queue executor so every MCP call is a harness
    action), `src/oauth/` subscription sign-in (the `e2e login`, `logout`,
    and `models` commands and the `e2e/oauth/*` model constructors; each
    constructor subpath is the place its `@ai-sdk/*` optional peers are
    imported, and the Copilot constructor loads `@ai-sdk/openai` lazily, only
    for the Responses models, so the CLI boots without any of them). The
    constructors and the CLI
    are the whole public surface: the flows, stores, and fetch behind them
    are module-private, not a library for other products. `tests/live/` holds hand-run
    checks that need a stored login and are never part of `pnpm test`.
- `packages/web` — the published `@e2e-dev/web` package: the
  browser engine, built with the public `defineEngine`, contributing the
  `browser` fixture and `expect(browser)`. It depends on `e2e` (peer), never the
  reverse; a target names it explicitly as `engine: web()`. There is
  no default engine and no well-known id registry in core. It imports from
  `e2e/engine` only: the semantics every engine must reproduce
  (error taxonomy, text and URL matching, assertion polling, JSON-value rules)
  are exported there, and there is no `e2e/internal` subpath.
- `packages/kernel` - the published `@e2e-dev/kernel` package: Kernel hosted
  browsers for the web engine. An official integration with a hosted service
  is one package per service, named after it (`@e2e-dev/<service>`), with the
  vendor SDK and the engine it plugs into as peers. It implements that
  engine's provider seam (`BrowserProvider` for web, `DeviceProvider` for
  mobile) and imports the engine's types only; the engines never know it
  exists.
- `packages/eas` - the published `@e2e-dev/eas` package: EAS Simulators
  hosted iOS simulators and Android emulators for the mobile engine
  (`DeviceProvider`). Expo publishes no SDK for the sessions API, so it calls
  Expo's GraphQL API with `fetch`, and `@e2e-dev/mobile` is its only peer.
- `apps/testbed` (`@e2e-dev/testbed`, private) — dogfood project that
  consumes the **built** packages like a real user would: the playground app
  where every runner feature (sessions, routes, downloads, frames, uploads,
  serial groups, the executor seams, verdict edge cases, the reporter under
  stress, `explore`) has a deterministic test. Hard UI surfaces belong to the
  benchmarks, not here.
- `apps/web-benchmark` (`@e2e-dev/web-benchmark`, private) — a Next.js app of
  self-contained hard-surface scenarios (shadow DOM, canvas, iframes, native
  dialogs, planted bugs) at `/e/<slug>`, copied from the tester-army web
  benchmark, plus the e2e suites written against them (`tests/` and
  `tests-agent/` both gate PRs; the agentic one runs from its committed
  recordings, see "Committed recordings" under Gotchas). Scenario files are
  copies: keep diffs against the source minimal so scenarios port both ways,
  and never fix a planted bug. The one exception is Control Inventory, ours
  like the mobile benchmark's: plain controls, one exercise per agent verb the
  hard scenarios never reach, with one agentic test per verb in
  `tests-agent/control-inventory.e2e.ts`.
- `apps/mobile-benchmark` (`@e2e-dev/mobile-benchmark`, private) — an Expo
  app of hard mobile surfaces (merged or hidden accessibility trees, native
  alerts over modals, keyboard-covered submits, virtualized lists, a WebView,
  OS permission and payment sheets), copied from the tester-army mobile
  benchmark, plus the e2e suites on the `@e2e-dev/mobile` engine
  (`tests/` locators only, `tests-agent/` one `agent.act` per scenario).
  Both suites run in CI on an iOS simulator and an Android emulator
  (`.github/workflows/mobile.yml`; the Expo build is cached per native
  fingerprint and its JS repacked on a hit); the agentic one replays
  committed recordings and calls the model for a step with none, see
  "Committed recordings" under Gotchas. Scenario files are copies: keep
  diffs against the source minimal, and name no company a scenario was
  distilled from.
- `examples/` — standalone user-facing projects, one per technology
  (`with-vite`, `with-next`, `with-expo`), each the same
  one-screen greeter demo with deterministic and agent tests. They install
  the published packages from npm, sit outside the pnpm workspace, commit no
  lockfile, and run in no CI; oxlint and fallow ignore them. A change runs
  the example's suite by hand and updates the "Last checked" line in its
  README. A native example keeps its tests in an `e2e/` folder beside the
  native project, as a user would.
- `docs/` (the Mintlify docs site; pages are the `.mdx` files under `docs/`,
  navigation, theme, and redirects in `docs/docs.json`, extra CSS in
  `docs/style.css`; `docs/examples/` is typechecked and shown verbatim on
  docs pages and in `skills/e2e/` (`docs/examples/skill/`), kept in sync by
  `scripts/check-docs-examples.ts`; a shell
  block that runs `npx` or `npm install`/`ci` sits in a `<CodeGroup>` of
  `npm`, `pnpm`, and `bun` blocks, which Mintlify syncs site-wide, enforced
  by `scripts/check-docs-package-managers.ts`). The `e2e` build copies the
  pages to `packages/e2e/docs/` (gitignored,
  `packages/e2e/scripts/prepare-build.ts`) so the published package ships
  them for agents to read offline.
- `skills/e2e/` — the agent skill for consumers: `SKILL.md` plus
  `references/<topic>.md`, one per `e2e guide` topic. It lives at the repo
  root because `npx skills add tester-army/e2e` only looks in well-known
  directories. The `e2e` build copies it to `packages/e2e/skills/`
  (gitignored) so the published package ships it; `src/cli/skill.ts` reads
  that copy first and the repo source as the fallback, and `e2e init` writes
  it into a project's `.agents/skills/` and `.claude/skills/`.

## Commands

Build first — nearly everything downstream consumes `dist`.

```bash
pnpm check          # lint -> check:dead-code -> typecheck -> docs:check-errors -> check:peer-ranges -> check:install-scripts -> docs:check (full gate)
pnpm test           # builds, then vitest unit + integration
pnpm test:testbed   # builds, then runs the real CLI against the playground app
pnpm test:web-benchmark   # builds, then runs the real CLI against the benchmark scenarios
```

Focused work:

```bash
pnpm --filter e2e run build
pnpm --filter e2e run test:unit                       # unit only, no build
pnpm --filter e2e exec vitest run tests/unit/scheduler.test.ts
pnpm --filter e2e exec vitest run -t 'name fragment'
pnpm --filter @e2e-dev/web run test
pnpm --filter @e2e-dev/testbed run test:headed
```

- Package `test` scripts do **not** build. Root `build` and `test` order the
  packages explicitly rather than relying on topological sort, because `e2e`
  devDepends on the web engine for its browser-backed integration tests
  while the engine peer-depends on `e2e` — pnpm reports that cycle on every
  install.
- `pnpm typecheck` runs `build` first, then per-package `typecheck`. The
  package `typecheck` covers `tests/**`, which is what makes
  `tests/types/sdk-types.ts` a test.
- Integration tests need Chromium: `pnpm --filter @e2e-dev/web exec
  playwright-core install chromium`. The web engine's `prepare` hook
  also installs a missing browser once per run, in the runner, before `plan`
  is emitted and the run's clock starts.

## Definition of done

Work is done when a human can review it without redoing any of it: verified
against the built packages, reviewed in a fresh context, green, every bot
thread handled, and labeled `Ready for Human Review`. "It compiles" and
"tests pass" are not done.

- Prove behavior with the `verify` skill (`.claude/skills/verify`) while
  iterating and before the PR: the built CLI on the testbed or a benchmark,
  the `e2e` MCP server (`.mcp.json`), a scratch project for `init`, the docs
  site. If you cannot verify something, say so; never imply you did.
- Every PR body states under `## Verified` whether it was run locally, with
  CLI output, screenshots, or video when it was, and a main-vs-branch table
  for fixes (`writing-pr` skill).
- Open every PR through the `ship-pr` skill (`.claude/skills/ship-pr`):
  checks, verification, fresh-context self-review, the PR, then the
  `babysit` skill (`.claude/skills/babysit`) until the label is on. Asking
  for a PR means asking for all of that. A push removes the label
  (`.github/workflows/review-label.yml`), so a labeled PR is always labeled
  for its current head.
- Never merge or approve.
- When a reviewer (human or bot) corrects the same thing twice, encode it:
  make it impossible in types or structure, else a lint rule or a test, else
  a skill line, in that order of preference.

## Non-obvious conventions

- **Relative imports carry the `.ts` extension** (`rewriteRelativeImportExtensions`).
  `import { x } from '../internal/ids.ts'` — not `.js`, not extensionless.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on. Optional
  properties use the conditional-spread idiom; `oxc/no-map-spread` is disabled
  for exactly that reason.
- Lint is `oxlint` with `correctness`/`suspicious`/`perf` as errors and
  `style`/`pedantic` off. `no-await-in-loop` is intentionally off (sequential
  execution is the runner's contract).
- `pnpm check:dead-code` runs [fallow](https://github.com/fallow-rs/fallow)
  (`.fallowrc.json`): unused files, exports, dependencies, and duplicate
  export names fail CI. An export whose only consumer is a test is dead
  production API - make it module-private or move it. The class-member rule is
  advisory (`warn`) because it misses getters and callback-invoked methods.
- JSDoc on new functions; avoid inline comments unless they explain *why*.

## Testing quirks

- Vitest 4, `pool: 'forks'`, two projects. `integration` is capped at
  `maxWorkers: 3` and runs in a later group — do not raise it; CPU starvation
  produces timeouts indistinguishable from real failures.
- Integration tests write throwaway projects into
  `packages/e2e/tests/tmp-projects/` (gitignored) and import the runner from
  `dist/` via a non-literal specifier so the fixture's `e2e` self-reference
  shares one registry. Stale `dist` means confusing failures — rebuild.
- Testbed suites beyond the default one never gate a PR: `test:agent` /
  `test:dogfood` (real model calls, need `AI_GATEWAY_API_KEY`, optional
  `E2E_MODEL=provider/model-id`, the testbed's own override) run only on the weekly
  `.github/workflows/agent.yml` schedule or by manual dispatch. Both run
  against local deterministic apps, so a failure there is ours.
- Agentic assertions must be model-portable: assert on meaning (`toContain`)
  and pair each agentic step with a deterministic locator check.

## Inspecting agent runs with unbox-ai

`e2e run --ai-trace` records every model call of a run to `.e2e/ai-trace.json`
in the AI SDK devtools database shape (`{ runs[], steps[] }`). One run per
agent step, named `<test title> · <api> "<label>"`; one entry per model round
trip (an `act` turn, a `waitFor` poll, a judgment repair round) with the exact
prompt, the tool definitions and their JSON schemas, the response, usage, model
latency, and provider metadata. Recorder: `src/internal/ai-trace.ts` (an AI SDK
`registerTelemetry` integration, attributed through an async-local scope set
in `run/execute.ts` and `run/steps.ts`; workers drain on `unit-done`).

Use [unbox-ai](https://github.com/tester-army/unbox-ai) to read it — never
`cat` or Read the file, it is megabytes of resent context. The skill in
`.claude/skills/unbox-ai/SKILL.md` has the full workflow and recipes (other
agents: `npx skills add tester-army/unbox-ai`). Start wide, then drill:

```bash
AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:agent -- --ai-trace --no-cache
npx unbox-ai runs apps/testbed/.e2e/ai-trace.json            # one line per agent step
npx unbox-ai summary apps/testbed/.e2e/ai-trace.json --run 3 # one step: turns, tokens, caching
npx unbox-ai tools apps/testbed/.e2e/ai-trace.json --run 3   # what the agent called, and how often
npx unbox-ai event apps/testbed/.e2e/ai-trace.json 2 --run 3 # one turn's new messages
npx unbox-ai compare apps/testbed/.e2e/ai-trace.json --run 3 --run 4 --trajectory
```

This is how to debug an agentic step: a wrong node id, a loop guard firing, a
prompt or tool description change, or where the tokens went. Reach for it
before changing prompts in `src/agent/`, and again after, with `compare`. In
integration tests, pass `runOptions: { aiTrace: true }` and read the file from
the fixture project (`tests/integration/agent-ai-trace.test.ts` shows how).

- Steps replayed from the replay cache make no model call and leave no run; use
  `--no-cache` when you want the whole flow traced.
- Cost shows as `-` in unbox-ai (the devtools shape carries none); the AI
  Gateway's `marketCost` is in each step's `output.providerMetadata`, and the
  `--debug` step table prints dollars.
- Live view while a suite runs: `npx unbox-ai devtools` in the project
  directory, then `E2E_DEVTOOLS=1 ... test:agent -- --workers 1` (the testbed
  agent config registers `@ai-sdk/devtools`; that recorder is one database
  per process, hence one worker). Prefer `--ai-trace` for anything to keep.
- "Trace" means three things here: the recorded actions the replay cache
  keeps (`trace-1` entries under `.e2e/cache/`), the Playwright trace
  artifact, and this AI trace. Say which.

## Cross-checking the web engine's tree

`packages/web/tests/integration/crosscheck.test.ts` reads every node of the
web engine's semantic tree against two oracles on the same page: Chrome's
accessibility tree over CDP (role, name, checked, disabled, expanded,
selected, pressed, heading level, and interactive nodes the tree left out)
and Playwright's `getByRole(role, { name })` round trip, exact but tolerant of
icon-font glyphs the way the engine's role locator is. It runs on the
fixture pages in `tests/crosscheck/fixtures.ts` under `pnpm test`, and on
every web-benchmark scenario in `benchmark.yml` or locally:

```bash
pnpm --filter @e2e-dev/web-benchmark run build && pnpm --filter @e2e-dev/web-benchmark run start &
CROSSCHECK_BENCHMARK_URL=http://127.0.0.1:4280 pnpm --filter @e2e-dev/web exec vitest run tests/integration/crosscheck.test.ts
```

- Every disagreement must be listed in `tests/crosscheck/expected.txt` with a
  reason; a new one fails, and so does a listed one that stopped happening.
  `E2E_CROSSCHECK_UPDATE=1` rewrites the file keeping the reasons and marks
  new lines `TODO`, which fails until someone writes one. Review its diff: a
  removed line is a fix, an added one a change in what the model reads.
- Deliberate vocabulary choices (a `listitem` named from content, `box`, an
  editor host as `textbox`, Chrome's own role names) are policies at the top
  of `tests/crosscheck/crosscheck.ts`, each with its reason, not lines.
- A reader change (`src/in-page/read-semantics.ts`) runs it before the PR.
  A bug in that family starts as a fixture page line here.
- `tests/integration/conformance.test.ts` holds the reader to a third
  oracle: the role and accessible-name expectations of the axe-core test
  suite (`tests/conformance/axe-core/`, vendored byte for byte through
  Playwright's copy, MPL-2.0). Its disagreements live in
  `tests/conformance/expected.txt` the same way, grouped by reason; a line
  that starts with `Bug:` is a fix waiting to be made, and the fix deletes it.
## Measuring a change against main

`pnpm bench:ab` runs a benchmark suite through two builds, the merge base
with `origin/main` (a worktree under the system temp directory, installed and
built once per commit) and the working tree, in pairs in a seeded random
order, and prints a markdown table for the PR body. Use it for any perf claim
and before and after a change to the runner, the agent loop, or an engine:

```bash
pnpm bench:ab -- tests-agent/control-inventory.e2e.ts --config e2e.agent.config.ts
pnpm bench:ab --suite testbed --threshold 3 -- tests/forms.e2e.ts
```

Arguments after `--` go to `e2e run`; the options are in the header of
`scripts/bench-ab.ts`. What it reports, in order:

- Behavior. A test whose status, attempts, or step sequence (kind, api,
  label, status, error code, cache mode) differs between the builds, or
  between two runs of one build, is listed and left out of the timings. This
  is the regression check: a perf change that alters behavior is not a perf
  change.
- Timings: the whole suite, the observe, action, and model event phases, and
  every step api, each as the median paired change with a bootstrap 95%
  interval, `faster`, `slower`, or `same` against `±--threshold`, else
  `unresolved`. Sampling stops once the suite's interval resolves.
- Counters that should not move within one build: steps, events by kind,
  observed nodes and bytes, cache modes, model calls and tokens. A change
  here is exact and needs no statistics.

Runs go with `CI=1`: committed recordings replay read-only, a step with none
calls the model. A load average above half the cores is warned about; shared
CI runners are too noisy for wall-time verdicts, so trust the behavior and
counter sections there. The harness's statistics have unit tests under
`scripts/bench-ab/` (`pnpm test:scripts`).
## Golden device trees

`packages/mobile/tests/fixtures/snapshots/{ios,android}/` holds raw
agent-device snapshots of the mobile benchmark's home list and every
scenario's first screen, captured from a real simulator and emulator, beside
the tree each one projects to (`<scenario>.tree.txt`: role, name, text,
value, states, test id, attributes, one node per line, no geometry).
`tests/unit/captured-snapshots.test.ts` projects them the way `observe` does
under `pnpm test`, so a change to `src/nodes.ts` shows up as a diff of the
trees, on both platforms, without a device.

- After a reader change, `E2E_GOLDEN_UPDATE=1 pnpm --filter @e2e-dev/mobile
  exec vitest run tests/unit/captured-snapshots.test.ts` rewrites the trees;
  the diff is what the model and the locators now read. Review it like code.
- Re-capture after an agent-device bump or an app change, with the current
  build installed (`pnpm ios` / `pnpm android` in the app), one platform at a
  time: `pnpm --filter @e2e-dev/mobile-benchmark run capture:snapshots
  --target ios-simulator` (or `android-emulator`), then update the trees. A
  bump that changes the snapshot shape is exactly what this catches.

## Gotchas

- Status prose drifts. `README.md` (the build copies it into `packages/e2e/`
  for npm) and the docs pages can claim things that have since landed or
  been removed (the located verbs and the locate cache are both gone, for
  example). Verify against `src/` before repeating or relying on any "not
  implemented yet" list — and fix the prose when you find it stale.
- Committed recordings. The two benchmarks commit their agentic suites' replay
  cache (`apps/web-benchmark/.e2e/cache/`,
  `apps/mobile-benchmark/.e2e/cache/`; their `.gitignore`s leave it
  tracked, the testbed's ignores its own, since fixture-app recordings are
  worth nothing to anyone). CI replays the entries read-only and calls the
  model for a step with no recording, so those suites gate a pull request at
  deterministic speed and cost, for this repository's branches only: a fork's
  pull request has no key. Re-record with the package's `test:agent` and
  commit the changed entries in the same pull request as the scenario change.
  The web benchmark's agent job runs with `--strict-cache`, so a recording a
  change broke fails with `REPLAY_STALE` instead of quietly calling the model.
  That includes a change to the cache key (`REPLAY_POLICY_VERSION`, a new key
  field, an engine minor): strict lists the file store and fails a step whose
  key misses while an entry recorded for the same step sits under another key
  (`cache/rekeyed.ts`). Only entries whose `recordedFor` names the whole step
  (params digest, occurrence, agent) count; a `read-write` replay completes
  an older one. Such a change re-records every entry and deletes the old ones
  in the same pull request. A step that was never recorded still runs live.
  The web benchmark's entries are in. The mobile benchmark's iOS entries are
  recorded on a Mac; nobody has recorded on an Android emulator yet, so the
  Android side spends model calls until an emulator recording is committed.
- No implicit default model. For the built-in agent, the entry's `model`
  serves `act`; the judgment calls (`assert`, `waitFor`, `extract`) use its
  `judge` when one is configured, else `model`. A judgment never sees the
  prior-step ledger or the acting agent's summaries, only the instruction and
  the current screen. Without a model, the first `agent` acquisition in a run
  reports one run-level `MODEL_UNAVAILABLE` and stops the run (exit 2). A
  custom executor handles `act` and `assert` through `runStep` and needs no
  model; its `waitFor` and `extract` still use the built-in judgments. No implicit target either: `targets` is required and
  each names its engine.
- Security invariants (fail closed when one cannot be enforced):
  - Secrets never reach model input, digests, logs, reports, or artifacts.
    Model input is the redacted semantic tree (as text or, on request, the
    redacted node tree), masked pixels only when masking is proven and no
    secret was filled, and the sanitized prior-step records. Once a secret is
    filled the viewport stays pixel-tainted for the rest of the attempt. A
    secret an engine resolves for an option the app sees (basic auth) is
    protected as text only: redacted everywhere text goes, pixels untouched.
    One exposure level per session (`SecretExposure` in `run/secrecy.ts`)
    decides pixels and the taint a saved session carries; traces and text
    downloads are rewritten whenever the session's ledger holds a value
    (`redactsRecordings`), since a plain string reaches the app unseen. What
    an executor keeps in `attempt.memory` is its own; the harness never
    reports it.
  - An agent's secret fill is authorized by the runner, not the model.
    `typeSecret` (`action-dispatcher.ts`) takes only a handle the step's
    params declare, the target resolves on the newest observation
    (`feed.resolve` and `requireLatest` in `observation-feed.ts`), and
    `authorizeSecretFill` (`secrets.ts`) requires the secret configured for
    the run, an enabled editable node, and a password field for a password.
    There is no origin check: the value goes to whatever site the page is on
    (`docs/security.mdx`). The model never sees or picks the value. A test's
    own `fill(secret)` is trusted code and runs none of these checks.
  - Every model tool call is parsed into a closed schema and authorized
    immediately before dispatch. Nothing runs on a refusal: an unknown tool
    name or an undeclared field goes back to the model as the call's error
    result (the AI SDK's `tool-error`, naming the tool or the field), the
    next turn is the repair, and refusals count toward the failure-streak
    guard. A node id not on the current screen is `LOCATOR_NOT_FOUND`, an
    action failure the model reads and re-aims from. `POLICY_DENIED` is for
    denied destinations, forbidden fills, and tainted pixels. Model text is
    never evaluated as code, selectors, shell, or config. App content, ledger
    text, and pixels are quoted as untrusted evidence with no policy authority.
  - Every navigation a test or the agent asks for (`app.open`,
    `browser.goto`, the `navigate` verb) goes through one rule,
    `resolveNavigationUrl`: only `http:`, `https:`, and the exact
    `about:blank` pass; every other scheme (`view-source:file:` included) and
    a malformed URL is `POLICY_DENIED` (a relative URL on a target with no
    `app.url` is `APP_URL_REQUIRED`). `device.openLink` takes custom app
    schemes, so it refuses a list instead (`packages/mobile/src/links.ts`):
    `file:`, `data:`, `javascript:`, `view-source:`, `blob:`, `filesystem:`.
    There is no origin or host allowlist; PR #290 removed them on purpose, since a
    click reaches any origin a typed URL could.
  - Sessions are per-run, target-bound, AES-256-GCM encrypted with a
    memory-only key, and deleted at cleanup; payloads never enter diagnostics.
  - Reports escape contextually, strip terminal controls, generate artifact
    names, and never let a label become a path component.
  - Test, config, and engine code run with the runner's full OS authority;
    nothing here sandboxes them. Untrusted PR code belongs in an external
    sandbox with no secrets or write tokens.

- CI: `.github/workflows/spec.yml` runs lint, typecheck, and the testbed on
  Node 26, `pnpm test` on the newest Node 22, 24, and 26 and on the
  `engines.node` floors (22.22.3, 24.8.0), and `scripts/install-smoke.ts`, a
  fresh install of the packed packages with pnpm 11 and 12; `benchmark.yml` runs the
  web benchmark's two suites; `mobile.yml` runs the mobile benchmark's on an
  iOS simulator and an Android emulator (KVM on x64 Linux). The two
  benchmark workflows gate on paths: a `changes` job (dorny/paths-filter
  over `.github/filters.yml`) skips the suites when the change reaches
  neither the runner, the engine, nor the benchmark app, and a manual
  dispatch always runs them. Skipped satisfies the ruleset's required
  checks; a workflow-level `paths:` filter would leave them pending, so
  never gate those workflows that way. The mobile suites are four named
  jobs sharing steps through YAML anchors, not a matrix: a skipped matrix
  job reports under its unexpanded name and the required check never
  arrives. A new build input or benchmark dependency goes into
  `filters.yml` in the same change. Every workflow
  pins actions by SHA; keep new actions SHA-pinned. Every job runs on
  Blacksmith, like the tester-army repos. Linux jobs use
  `blacksmith-4vcpu-ubuntu-2404` and macOS jobs `blacksmith-6vcpu-macos-26`;
  keep new jobs on those labels. The one exception is the `release` job:
  npm Trusted Publishing rejects OIDC tokens from self-hosted runners, and
  Blacksmith counts as one, so it stays on `ubuntu-latest`.
- Commits follow Conventional Commits; PRs are squash-merged with the number in
  the subject.
- PR titles and bodies follow the `writing-pr` skill
  (`.claude/skills/writing-pr/SKILL.md`). `unslop`
  (`.claude/skills/unslop/SKILL.md`, from `okwasniewski/dotfiles`) applies to
  any prose an agent writes here; other agents install it with
  `npx skills add okwasniewski/dotfiles --skill unslop`.
- Releases go through changesets: a user-visible change adds a `.changeset/`
  entry. Peer ranges point one way only (engine -> `e2e`, integration ->
  engine) and read `>=<major.minor.patch> <major+1>` of the sibling the
  package was built against (`>=0.15.0 <1` on the runner today);
  `scripts/check-peer-ranges.ts` (`pnpm check`) fails on any other shape for
  every peer one package under `packages/` has on another (vendor SDK peers
  such as `@onkernel/sdk` are not checked). Narrow or exact, every runner minor (exact: every patch too)
  falls out of range, and changesets 3 then patch-bumps each engine and
  rewrites its pin, never a major (`determineDependents` in
  `@changesets/assemble-release-plan` patches an out-of-range peer dependent).
  That republishes every engine on every runner release, and a consumer who
  updates `e2e` alone is left with an exact peer npm 7+ refuses (ERESOLVE). A
  runner major is the one legitimate rewrite (`>=1.0.0 <2.0.0`, engines
  patched): `version-packages` runs `scripts/restore-peer-ranges.ts` after
  `changeset version`, which puts that in shape and leaves a wide range alone.
- The root `release` script publishes with no `--tag`, so versioned releases
  land on `latest`. `changeset publish` passes `--tag` through to the publish
  tool when given one, so `publishConfig.tag: "latest"` on every package is
  only a backstop for a hand-run `npm publish` (`pnpm publish` ignores it).
  Canaries pass `--tag canary` explicitly and never move `latest`.
  Do not switch to changesets pre mode to get a real prerelease version: a
  `0.16.0-beta.0` runner is outside the engine's `e2e` peer range, so
  changesets patch-bumps `@e2e-dev/web` and rewrites the peer to
  `>=0.16.0-beta.0 <0.16.0`, which no stable runner satisfies. Widening the range does not
  rescue it — node-semver only lets a prerelease satisfy a comparator set when a
  comparator with the same `major.minor.patch` carries a prerelease, so
  `0.3.0-beta.0` satisfies neither `>=0.1.0-0 <1` nor `*`. Never hand-edit a
  package `version` or `CHANGELOG.md`; `changesets/action` owns both.
- Canaries are hand-run, never from CI: `pnpm run canary` with `GITHUB_TOKEN`
  set versions and builds every public package as a changesets snapshot, and
  `pnpm run canary:publish` publishes them to the `canary` dist-tag, then runs
  `scripts/restore-peer-ranges.ts`. Publishing
  is its own step because npm's two-factor prompt is interactive. Never publish
  without building first: each build stamps `dist/.build.json`, and every
  package's `prepublishOnly` (`scripts/check-dist.ts`) refuses a `dist` whose
  stamp does not match `package.json`. `scripts/canary-changeset.ts` first writes a changeset bumping all
  of them, so they move together: a snapshot of one engine alone would keep a
  peer range the runner's canary does not satisfy. Snapshot versions read
  `0.10.0-canary-<datetime>` (`snapshot.useCalculatedVersion`); the build runs
  after `changeset version` so `init` records those versions, and `init` pins a
  prerelease engine exactly, since a caret on a prerelease resolves to the
  newest canary of that tuple, whose peer range names a different runner build.
  The snapshot also pins every `e2e` peer to that runner build (and an
  integration's engine peer to that engine build), since a prerelease
  satisfies no `>=x <1` range: the tarballs need the pin, main must not keep
  it, so the restore step widens it to `>=<sibling major.minor.patch> <1`
  before the output (versions, changelogs, consumed changesets, peers) is
  committed to main as `chore: release`. A `changeset publish` typed by hand
  needs `node scripts/restore-peer-ranges.ts` after it, or `pnpm check` fails
  on the pin.
- The runner publishes as the unscoped `e2e` (entry points `e2e`, `e2e/agent`,
  `e2e/engine`, `e2e/oauth/chatgpt`, `e2e/oauth/copilot`, `e2e/oauth/grok`, `e2e/oauth/opencode-console`; the bin is `e2e` too); engines, reporters, and integrations publish public
  under the `@e2e-dev` scope. The `@e2edev` scope (moved to `@e2e-dev` on
  2026-09-28), `@e2edev/e2e`, `@e2edev/oauth` (folded into `e2e/oauth` on
  2026-09-21), and `@e2e-dev/integrations` (moved to `@e2e-dev/kernel` on
  2026-09-29, deprecated by hand after the first `@e2e-dev/kernel` publish)
  are the retired names: deprecated on npm, never referenced here. The release job authenticates with npm
  Trusted Publishing (OIDC), no token; each package carries its own trusted
  publisher connection on npmjs (see "npm Trusted Publishing" in
  CONTRIBUTING.md). Provenance attaches automatically once the repository
  is public.
  Document the CLI as `npx e2e`; npx runs the locally installed bin first, and
  the flag `--no-install` adds nothing once the package is a dependency.
- Private packages are skipped entirely by changesets (`privatePackages: false`),
  so `@e2e-dev/testbed` gets no version bump, no `CHANGELOG.md`, and no git tag.
