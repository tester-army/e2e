# AGENTS.md

`e2e` — an agentic end-to-end testing framework. pnpm monorepo, ESM only,
TypeScript 7.

## Contracts

There is no separate spec. The code is the contract, pinned in three places:

- The emitted `packages/e2e/dist/index.d.ts` (and `dist/engine/index.d.ts`)
  is the public API. `packages/e2e/tests/types/sdk-types.ts` holds compile-time
  assertions (`@ts-expect-error` lines) for the parts that are easy to loosen
  by accident; it runs under the package `typecheck`, never under vitest.
- Wire formats live in `packages/e2e/schema/*.schema.json` (report-1,
  session-1, agent-judgment-1, agent-tool-1) with a valid and an invalid fixture
  each. Integration tests validate every generated report and session envelope
  against them; `tests/unit/schema-fixtures.test.ts` checks the fixtures. A
  wire change edits the schema, both fixtures, and the producer in one review.
- Security invariants are the list under Gotchas below, enforced by tests in
  `tests/integration/agent-policy.test.ts` and the secret-ledger unit tests.
- Behavior changes update the matching `fern/docs/pages/*.mdx` page in the same
  change, including "not implemented yet" callouts, and `skills/e2e/` when the
  changed surface is described there.

There are no RFCs or design documents in the repo. The why lives in PR
descriptions and commit bodies; `git log` and `gh pr view` are the archive.

## Layout

- `packages/e2e` — the published `@e2edev/e2e` package: SDK surface, runner, CLI,
  `@e2edev/e2e/engine` contract. Core knows the contract and never an engine's
  internals: no `Web`, `browser`, `page`, `route`, or `playwright` noun lives in
  `src/` (grep for them; zero hits is the invariant). The one exception is the
  `e2e init` scaffold presets in `src/cli/init/engines.ts`, which write the
  user's config and so name engine packages as text. Each preset owns its
  prompt label, dependencies, config, example, and run command; interactive
  choices derive from this list. These presets never import engine implementations.
  - `src/run/` runner core (scheduler, units, workers, retries, sessions),
    `src/collect/` registration+selection, `src/locator/` locator AST/engine,
    `src/agent/` the agent (the `act` executor socket plus the judgment
    methods).
- `packages/playwright` — the published `@e2edev/playwright` package: the
  browser engine, built with the public `defineEngine`, contributing the
  `web` fixture and `expect(web)`. It depends on `@e2edev/e2e` (peer), never the
  reverse; a target names it explicitly as `engine: playwright()`. There is
  no default engine and no well-known id registry in core. It imports from
  `@e2edev/e2e/engine` only: the semantics every engine must reproduce
  (error taxonomy, text and URL matching, assertion polling, JSON-value rules)
  are exported there, and there is no `@e2edev/e2e/internal` subpath.
- `packages/testbed` (`@e2edev/testbed`, private) — dogfood project that
  consumes the **built** packages like a real user would.
- `fern/` (docs site).
- `skills/e2e/` — the agent skill for consumers: `SKILL.md` plus
  `references/<topic>.md`, one per `e2e guide` topic. It lives at the repo
  root because `npx skills add tester-army/e2e` only looks in well-known
  directories. The `@e2edev/e2e` build copies it to `packages/e2e/skills/`
  (gitignored) so the published package ships it; `src/cli/skill.ts` reads
  that copy first and the repo source as the fallback, and `e2e init` writes
  it into a project's `.agents/skills/` and `.claude/skills/`.

## Commands

Build first — nearly everything downstream consumes `dist`.

```bash
pnpm check          # lint -> check:dead-code -> typecheck -> docs:check (full gate)
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
  devDepends on the playwright engine for its browser-backed integration tests
  while the engine peer-depends on `e2e` — pnpm reports that cycle on every
  install.
- `pnpm typecheck` runs `build` first, then per-package `typecheck`. The
  package `typecheck` covers `tests/**`, which is what makes
  `tests/types/sdk-types.ts` a test.
- Integration tests need Chromium: `pnpm --filter @e2edev/playwright exec
  playwright install chromium`. The engine's `init` hook also installs
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

- Status prose drifts. `packages/e2e/README.md` and the fern pages can claim
  things that have since landed or been removed (the located verbs and the
  locate cache are both gone, for example). Verify against `src/` before
  repeating or relying on any "not implemented yet" list — and fix the prose
  when you find it stale.
- No implicit default model. Agent fixtures without model config fail with
  `MODEL_UNAVAILABLE`. No implicit target either: `targets` is required and
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
    immediately before dispatch; unknown tools or fields, stale observation
    refs, and denied destinations are `POLICY_DENIED`. Model text is never
    evaluated as code, selectors, shell, or config. App content, ledger text,
    and pixels are quoted as untrusted evidence with no policy authority.
  - Navigation is checked against the target's allowed origins on every hop
    (initial URL, redirects, popups, frames, agent requests). `file:`, `data:`,
    `javascript:`, link-local, and cloud-metadata destinations are denied.
  - Sessions are per-run, target-bound, AES-256-GCM encrypted with a
    memory-only key, and deleted at cleanup; payloads never enter diagnostics.
  - Reports escape contextually, strip terminal controls, generate artifact
    names, and never let a label become a path component.
  - Test, config, and engine code run with the runner's full OS authority;
    nothing here sandboxes them. Untrusted PR code belongs in an external
    sandbox with no secrets or write tokens.

- CI (`.github/workflows/spec.yml`) runs lint, typecheck, and the testbed on Node 26 and `pnpm test` on Node 22, 24, and 26, and pins actions by SHA; keep
  new actions SHA-pinned.
- Commits follow Conventional Commits; PRs are squash-merged with the number in
  the subject.
- PR titles and bodies follow the `writing-pr` skill
  (`.claude/skills/writing-pr/SKILL.md`). `unslop`
  (`.claude/skills/unslop/SKILL.md`, from `okwasniewski/dotfiles`) applies to
  any prose an agent writes here; other agents install it with
  `npx skills add okwasniewski/dotfiles --skill unslop`.
- Releases go through changesets: a user-visible change adds a `.changeset/`
  entry. Peer ranges point one way only (engine -> `@e2edev/e2e`, widened to `>=x <1`);
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
  outside the engine's `@e2edev/e2e` peer range, which majors `@e2edev/playwright` on
  every runner minor and rewrites the peer range. Widening the range does not
  rescue it — node-semver only lets a prerelease satisfy a comparator set when a
  comparator with the same `major.minor.patch` carries a prerelease, so
  `0.3.0-beta.0` satisfies neither `>=0.1.0-0 <1` nor `*`. Never hand-edit a
  package `version` or `CHANGELOG.md`; `changesets/action` owns both.
- Private phase: every package publishes restricted under the `@e2edev`
  scope (`e2e` -> `@e2edev/e2e`; entry points follow the name). Provenance
  is off (npm only attests public packages) and the release job authenticates
  with the `NPM_TOKEN` secret. The unscoped `e2e` on npmjs is a placeholder
  the team reserved: never document a bare `npx e2e`, always
  `npx --no-install e2e`.
- Private packages are skipped entirely by changesets (`privatePackages: false`),
  so `@e2edev/testbed` gets no version bump, no `CHANGELOG.md`, and no git tag.
