# AGENTS.md

`e2e` — an open standard for agentic end-to-end testing plus its reference
implementation. pnpm monorepo, ESM only, TypeScript 7.

## The spec wins

`spec/` is a frozen normative contract, not documentation.

- `spec/api/e2e.d.ts` (`sdk-0.1`) is canonical for the test API. `spec/api/
  driver.d.ts` (`driver-1`) describes the retired driver SPI: the runner now
  speaks the backend contract (`@e2edev/e2e/backend`, RFC0002), and spec chapter 09 is
  scheduled to retire into a backends chapter (RFC0002 migration step 5). Until
  then the spec and `src/backend/` intentionally diverge on that surface.
- Wire output must validate against `spec/schema/*.schema.json`; integration
  tests validate every generated report against `report-v1.schema.json`.
- A spec change touches declarations, schemas, prose, examples, and tests in
  one review. Implementation shortcuts never amend the spec.
- `pnpm check:manifest` (`scripts/check-manifest-coupling.mjs`, run as its own
  PR job) fails any diff that edits `spec/conformance/v0-requirements.json` or
  `spec/schema/*` without bumping `suiteVersion`.
- Behavior changes update the matching `fern/docs/pages/*.mdx` page in the same
  change, including "not implemented yet" callouts.

## Layout

- `packages/e2e` — the published `@e2edev/e2e` package: SDK surface, runner, CLI,
  `@e2edev/e2e/backend` contract. Core knows the contract and never a backend's
  internals: no `Web`, `browser`, `page`, `route`, or `playwright` noun lives in
  `src/` (grep for them; zero hits is the invariant). The one exception is the
  `e2e init` scaffold template in `src/cli/init.ts`, which writes the user's
  config and so names `@e2edev/playwright` as text.
  - `src/run/` runner core (scheduler, units, workers, retries, sessions),
    `src/collect/` registration+selection, `src/locator/` locator AST/engine,
    `src/agent/` the agent (the `act` executor socket plus the judgment
    methods).
- `packages/playwright` — the published `@e2edev/playwright` package: the
  browser backend, built with the public `defineBackend`, contributing the
  `web` fixture and `expect(web)`. It depends on `@e2edev/e2e` (peer), never the
  reverse; a target names it explicitly as `backend: playwright()`. There is
  no default backend and no well-known id registry in core. It imports from
  `@e2edev/e2e/backend` only: the semantics the spec makes every backend reproduce
  (error taxonomy, text and URL matching, assertion polling, JSON-value rules)
  are exported there, and there is no `@e2edev/e2e/internal` subpath.
- `packages/testbed` (`@e2edev/testbed`, private) — dogfood project that
  consumes the **built** packages like a real user would.
- `spec/`, `fern/` (docs site), `RFC0001.md` (direction: e2e v2 on the
  TesterArmy engine).

## Commands

Build first — nearly everything downstream consumes `dist`.

```bash
pnpm check          # lint -> check:spec -> typecheck -> docs:check (full gate)
pnpm test           # builds, then vitest unit + integration
pnpm test:testbed   # builds, then runs the real CLI against the playground app
```

Focused work:

```bash
pnpm --filter @e2edev/e2e run build
pnpm --filter @e2edev/e2e run test:unit                       # unit only, no build
pnpm --filter @e2edev/e2e exec vitest run tests/unit/scheduler.test.ts
pnpm --filter @e2edev/e2e exec vitest run -t 'name fragment'
pnpm --filter @e2edev/playwright run test
pnpm --filter @e2edev/testbed run test:headed
```

- Package `test` scripts do **not** build. Root `build` and `test` order the
  packages explicitly rather than relying on topological sort, because `@e2edev/e2e`
  devDepends on the playwright backend for its browser-backed integration tests
  while the backend peer-depends on `e2e` — pnpm reports that cycle on every
  install.
- `pnpm typecheck` runs `build` first, then per-package `typecheck`.
- `pnpm check:spec` typechecks `spec/api` + `spec/examples` under a separate,
  stricter config (`skipLibCheck: false`, DOM lib) — it can fail while package
  typecheck passes.
- Integration tests need Chromium: `pnpm --filter @e2edev/playwright exec
  playwright install chromium`. The backend's `init` hook also installs
  missing browsers once per worker, before any attempt starts.

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
  `dist/` via a non-literal specifier so the fixture's `@e2edev/e2e` self-reference
  shares one registry. Stale `dist` means confusing failures — rebuild.
- Testbed suites beyond the default one never gate a PR: `test:public` and
  `test:selenium` (real websites) run in no workflow, and `test:agent` /
  `test:dogfood` (real model calls, need `E2E_MODEL_API_KEY`, optional
  `E2E_MODEL=provider/model-id`) run only on the weekly
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
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent -- --ai-trace --no-cache
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

- Status prose drifts. `packages/e2e/README.md` and `spec/README.md` can claim
  things that have since landed or been removed (the located verbs and the
  locate cache are both gone, for example). Verify against `src/` before
  repeating or relying on any "not implemented yet" list — and fix the prose
  when you find it stale.
- No implicit default model. Agent fixtures without model config fail with
  `MODEL_UNAVAILABLE`. No implicit target either: `targets` is required and
  each names its backend.
- Secrets must never reach model input, digests, logs, or reports. Model input
  is the redacted semantic tree plus the bounded ledger only.
- CI (`.github/workflows/spec.yml`) runs Node 26 and pins actions by SHA; keep
  new actions SHA-pinned.
- Commits follow Conventional Commits; PRs are squash-merged with the number in
  the subject.
- Releases go through changesets: a user-visible change adds a `.changeset/`
  entry. Peer ranges point one way only (backend -> `@e2edev/e2e`, widened to `>=x <1`);
  making them mutual or narrow forces changesets to bump both packages to a
  major on every release.
- The root `release` script publishes with `--tag beta`, so releases land on the
  `beta` dist-tag and never move an existing `latest`. That flag is what does the
  work: `changeset publish` always passes `--tag` through to the publish tool, so
  the matching `publishConfig.tag` on both packages is only a backstop for a
  hand-run `npm publish` — `pnpm publish` ignores it. One leak is not fixable
  here: npmjs auto-assigns `latest` on a package's *first* publish in addition to
  `--tag`, so a brand-new package lands on `latest` once regardless.
  Do not switch to changesets pre mode to get a real prerelease version: it is
  outside the backend's `@e2edev/e2e` peer range, which majors `@e2edev/playwright` on
  every runner minor and rewrites the peer range. Widening the range does not
  rescue it — node-semver only lets a prerelease satisfy a comparator set when a
  comparator with the same `major.minor.patch` carries a prerelease, so
  `0.3.0-beta.0` satisfies neither `>=0.1.0-0 <1` nor `*`. Never hand-edit a
  package `version` or `CHANGELOG.md`; `changesets/action` owns both.
- Private phase: every package publishes restricted under the `@e2edev`
  scope (`e2e` -> `@e2edev/e2e`; entry points follow the name). Provenance
  is off (npm only attests public packages) and the release job authenticates
  with the `NPM_TOKEN` secret. The unscoped `e2e` on npmjs is a foreign package:
  never document a bare `npx e2e`, always `npx --no-install e2e`.
- Private packages are skipped entirely by changesets (`privatePackages: false`),
  so `@e2edev/testbed` gets no version bump, no `CHANGELOG.md`, and no git tag.
