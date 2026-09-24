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
    constructor subpath is the only place its `@ai-sdk/*` optional peer is
    imported, so the CLI boots without them). The constructors and the CLI
    are the whole public surface: the flows, stores, and fetch behind them
    are module-private, not a library for other products. `tests/live/` holds hand-run
    checks that need a stored login and are never part of `pnpm test`.
- `packages/web` — the published `@e2edev/web` package: the
  browser engine, built with the public `defineEngine`, contributing the
  `web` fixture and `expect(web)`. It depends on `e2e` (peer), never the
  reverse; a target names it explicitly as `engine: web()`. There is
  no default engine and no well-known id registry in core. It imports from
  `e2e/engine` only: the semantics every engine must reproduce
  (error taxonomy, text and URL matching, assertion polling, JSON-value rules)
  are exported there, and there is no `e2e/internal` subpath.
- `packages/testbed` (`@e2edev/testbed`, private) — dogfood project that
  consumes the **built** packages like a real user would: the playground app
  where every runner feature (sessions, routes, downloads, frames, uploads,
  serial groups, the executor seams, verdict edge cases, the reporter under
  stress, `explore`) has a deterministic test. Hard UI surfaces belong to the
  benchmarks, not here.
- `packages/web-benchmark` (`@e2edev/web-benchmark`, private) — a Next.js app of
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
- `packages/mobile-benchmark` (`@e2edev/mobile-benchmark`, private) — an Expo
  app of hard mobile surfaces (merged or hidden accessibility trees, native
  alerts over modals, keyboard-covered submits, virtualized lists, a WebView,
  OS permission and payment sheets), copied from the tester-army mobile
  benchmark, plus the e2e suites on the `@e2edev/mobile` engine
  (`tests/` locators only, `tests-agent/` one `agent.act` per scenario).
  Both suites run in CI on an iOS simulator and an Android emulator
  (`.github/workflows/mobile.yml`; the Expo build is cached per native
  fingerprint and its JS repacked on a hit); the agentic one replays
  committed recordings and calls the model for a step with none, see
  "Committed recordings" under Gotchas. Scenario files are copies: keep
  diffs against the source minimal, and name no company a scenario was
  distilled from.
- `docs/` (the Mintlify docs site; pages are the `.mdx` files under `docs/`,
  navigation, theme, and redirects in `docs/docs.json`, extra CSS in
  `docs/style.css`; `docs/examples/` is typechecked and shown verbatim in the
  quickstart, kept in sync by `scripts/check-docs-examples.ts`).
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
pnpm check          # lint -> check:dead-code -> typecheck -> docs:check-errors -> check:peer-ranges -> docs:check (full gate)
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
pnpm --filter @e2edev/web run test
pnpm --filter @e2edev/testbed run test:headed
```

- Package `test` scripts do **not** build. Root `build` and `test` order the
  packages explicitly rather than relying on topological sort, because `e2e`
  devDepends on the web engine for its browser-backed integration tests
  while the engine peer-depends on `e2e` — pnpm reports that cycle on every
  install.
- `pnpm typecheck` runs `build` first, then per-package `typecheck`. The
  package `typecheck` covers `tests/**`, which is what makes
  `tests/types/sdk-types.ts` a test.
- Integration tests need Chromium: `pnpm --filter @e2edev/web exec
  playwright install chromium`. The web engine's `prepare` hook
  also installs a missing browser once per run, in the runner, before `plan`
  is emitted and the run's clock starts.

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
AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:agent -- --ai-trace --no-cache
npx unbox-ai runs packages/testbed/.e2e/ai-trace.json            # one line per agent step
npx unbox-ai summary packages/testbed/.e2e/ai-trace.json --run 3 # one step: turns, tokens, caching
npx unbox-ai tools packages/testbed/.e2e/ai-trace.json --run 3   # what the agent called, and how often
npx unbox-ai event packages/testbed/.e2e/ai-trace.json 2 --run 3 # one turn's new messages
npx unbox-ai compare packages/testbed/.e2e/ai-trace.json --run 3 --run 4 --trajectory
```

This is how to debug an agentic step: a wrong node id, a loop guard firing, a
prompt or tool description change, or where the tokens went. Reach for it
before changing prompts in `src/agent/`, and again after, with `compare`. In
integration tests, pass `runOptions: { aiTrace: true }` and read the file from
the fixture project (`tests/integration/agent-ai-trace.test.ts` shows how).

- Steps the trace cache replays make no model call and leave no run; use
  `--no-cache` when you want the whole flow traced.
- Cost shows as `-` in unbox-ai (the devtools shape carries none); the AI
  Gateway's `marketCost` is in each step's `output.providerMetadata`, and the
  `--debug` step table prints dollars.
- Live view while a suite runs: `npx unbox-ai devtools` in the project
  directory, then `E2E_DEVTOOLS=1 ... test:agent -- --workers 1` (the testbed
  agent config registers `@ai-sdk/devtools`; that recorder is one database
  per process, hence one worker). Prefer `--ai-trace` for anything to keep.
- "Trace" means three things here: the trace cache (`trace-1`, recorded
  actions under `.e2e/cache/`), the Playwright trace artifact, and this AI
  trace. Say which.

## Gotchas

- Status prose drifts. `packages/e2e/README.md` and the docs pages can claim
  things that have since landed or been removed (the located verbs and the
  locate cache are both gone, for example). Verify against `src/` before
  repeating or relying on any "not implemented yet" list — and fix the prose
  when you find it stale.
- Committed recordings. The two benchmarks commit their agentic suites' trace
  cache (`packages/web-benchmark/.e2e/cache/`,
  `packages/mobile-benchmark/.e2e/cache/`; their `.gitignore`s leave it
  tracked, the testbed's ignores its own, since fixture-app recordings are
  worth nothing to anyone). CI replays the entries read-only and calls the
  model for a step with no recording, so those suites gate a pull request at
  deterministic speed and cost, for this repository's branches only: a fork's
  pull request has no key. Re-record with the package's `test:agent` and
  commit the changed entries in the same pull request as the scenario change.
  The web benchmark's entries are in. The mobile benchmark's iOS entries are
  recorded on a Mac; nobody has recorded on an Android emulator yet, so the
  Android side spends model calls until an emulator recording is committed.
- No implicit default model. One canonical model per slot: the one
  `createAgent({ model })` brought, else `agent.model`, serves `act`; the
  judgment calls (`assert`, `waitFor`, `extract`) use `judge` when one is
  configured the same way, else `model`. Two that differ within a slot are
  `INVALID_CONFIG`. A judgment never sees the prior-step ledger or the acting
  agent's summaries, only the instruction and the current screen. Without a
  model, the first
  `agent` acquisition in a run reports one run-level `MODEL_UNAVAILABLE` and
  stops the run (exit 2). No implicit target either: `targets` is required and
  each names its engine.
- Security invariants (fail closed when one cannot be enforced):
  - Secrets never reach model input, digests, logs, reports, or artifacts.
    Model input is the redacted semantic tree (as text or, on request, the
    redacted node tree), masked pixels only when masking is proven and no
    secret was filled, and the sanitized prior-step records. Once a secret is
    filled the viewport stays pixel-tainted for the rest of the attempt. What
    an executor keeps in `attempt.memory` is its own; the harness never
    reports it.
  - A secret fill is authorized by the runner, not the model: authentic
    unresolved handle, a secure sink, allowed top-level and frame origin, an
    editable node with a compatible purpose, a current observation, and no
    control transfer since. The model never sees or picks the value.
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
  - Every navigation a test or the agent asks for (`app.open`, the `navigate`
    verb, `device.openLink`) goes through one rule: `file:`, `data:`, and
    `javascript:` destinations and malformed URLs are `POLICY_DENIED`. There
    is no origin or host allowlist; PR #290 removed them on purpose, since a
    click reaches any origin a typed URL could.
  - Sessions are per-run, target-bound, AES-256-GCM encrypted with a
    memory-only key, and deleted at cleanup; payloads never enter diagnostics.
  - Reports escape contextually, strip terminal controls, generate artifact
    names, and never let a label become a path component.
  - Test, config, and engine code run with the runner's full OS authority;
    nothing here sandboxes them. Untrusted PR code belongs in an external
    sandbox with no secrets or write tokens.

- CI: `.github/workflows/spec.yml` runs lint, typecheck, and the testbed on
  Node 26 and `pnpm test` on Node 22, 24, and 26; `benchmark.yml` runs the
  web benchmark's two suites; `mobile.yml` runs the mobile benchmark's on an
  iOS simulator and an Android emulator (KVM on x64 Linux). Every workflow
  pins actions by SHA; keep new actions SHA-pinned. Every job runs on
  Blacksmith, like the tester-army repos. Linux jobs use
  `blacksmith-4vcpu-ubuntu-2404` and macOS jobs `blacksmith-6vcpu-macos-26`;
  keep new jobs on those labels.
- Commits follow Conventional Commits; PRs are squash-merged with the number in
  the subject.
- PR titles and bodies follow the `writing-pr` skill
  (`.claude/skills/writing-pr/SKILL.md`). `unslop`
  (`.claude/skills/unslop/SKILL.md`, from `okwasniewski/dotfiles`) applies to
  any prose an agent writes here; other agents install it with
  `npx skills add okwasniewski/dotfiles --skill unslop`.
- Releases go through changesets: a user-visible change adds a `.changeset/`
  entry. Peer ranges point one way only (engine -> `e2e`) and read
  `>=<major.minor.patch> <major+1>` of the runner the engine was built against
  (`>=0.15.0 <1` today); `scripts/check-peer-ranges.ts` (`pnpm check`) fails on
  any other shape. Narrow or exact, every runner minor (exact: every patch too)
  falls out of range, and changesets 3 then patch-bumps each engine and
  rewrites its pin, never a major (`determineDependents` in
  `@changesets/assemble-release-plan` patches an out-of-range peer dependent).
  That republishes every engine on every runner release, and a consumer who
  updates `e2e` alone is left with an exact peer npm 7+ refuses (ERESOLVE). A
  runner major is the one legitimate rewrite (`>=1.0.0 <2.0.0`, engines
  patched): `version-packages` runs `scripts/restore-peer-ranges.ts` after
  `changeset version`, which puts that in shape and leaves a wide range alone.
- The root `release` script publishes with `--tag beta`, so releases land on the
  `beta` dist-tag and never move an existing `latest`. That flag is what does the
  work: `changeset publish` always passes `--tag` through to the publish tool, so
  the matching `publishConfig.tag` on both packages is only a backstop for a
  hand-run `npm publish` — `pnpm publish` ignores it. One leak is not fixable
  here: npmjs auto-assigns `latest` on a package's *first* publish in addition to
  `--tag`, so a brand-new package lands on `latest` once regardless.
  Do not switch to changesets pre mode to get a real prerelease version: a
  `0.16.0-beta.0` runner is outside the engine's `e2e` peer range, so
  changesets patch-bumps `@e2edev/web` and rewrites the peer to
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
  The snapshot also pins every `e2e` peer to that runner build, since a
  prerelease satisfies no `>=x <1` range: the tarballs need the pin, main must
  not keep it, so the restore step widens it to `>=<runner major.minor.patch> <1`
  before the output (versions, changelogs, consumed changesets, peers) is
  committed to main as `chore: release`. A `changeset publish` typed by hand
  needs `node scripts/restore-peer-ranges.ts` after it, or `pnpm check` fails
  on the pin.
- The runner publishes as the unscoped `e2e` (entry points `e2e`, `e2e/agent`,
  `e2e/engine`, `e2e/oauth/chatgpt`, `e2e/oauth/copilot`, `e2e/oauth/grok`; the bin is `e2e` too); engines and reporters publish public
  under the `@e2edev` scope. `@e2edev/e2e` and `@e2edev/oauth` (folded into
  `e2e/oauth` on 2026-09-21) are the retired names: deprecated on npm, never
  referenced here. Provenance stays off until the repository is
  public, and the release job authenticates with the `NPM_TOKEN` secret.
  Document the CLI as `npx e2e`; npx runs the locally installed bin first, and
  the flag `--no-install` adds nothing once the package is a dependency.
- Private packages are skipped entirely by changesets (`privatePackages: false`),
  so `@e2edev/testbed` gets no version bump, no `CHANGELOG.md`, and no git tag.
