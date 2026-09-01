# AGENTS.md

`e2e` — an open standard for agentic end-to-end testing plus its reference
implementation. pnpm monorepo, ESM only, TypeScript 7.

## The spec wins

`spec/` is a frozen normative contract, not documentation.

- `spec/api/e2e.d.ts` (`sdk-0.1`) and `spec/api/driver.d.ts` (`driver-1`) are
  canonical. Implementation code must match them, not the reverse.
- `packages/e2e/tests/contract/driver-spec-drift.ts` fails the build if
  `src/driver/index.ts` and `spec/api/driver.d.ts` diverge structurally. Any
  change to either requires the same change in the other. Run via
  `pnpm --filter e2e run check:driver-drift` (already inside `typecheck`).
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

- `packages/e2e` — the published `e2e` package: SDK surface, runner, CLI,
  `e2e/driver` SPI.
  - `src/run/` runner core (scheduler, units, workers, retries, sessions),
    `src/collect/` registration+selection, `src/locator/` locator AST/engine,
    `src/agent/` the agent (the `act` executor socket plus the judgment
    methods).
- `packages/playwright` — the published `@e2edev/playwright` package: the
  reference web driver. It depends on `e2e` (peer), never the reverse. The
  runner loads it on demand for `driver: 'playwright'`; `src/config/drivers.ts`
  is the one place that maps a well-known driver id to its package.
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
pnpm --filter e2e run build
pnpm --filter e2e run test:unit                       # unit only, no build
pnpm --filter e2e exec vitest run tests/unit/scheduler.test.ts
pnpm --filter e2e exec vitest run -t 'name fragment'
pnpm --filter @e2edev/playwright run test
pnpm --filter @e2edev/testbed run test:headed
```

- Package `test` scripts do **not** build. Root `build` and `test` order the
  packages explicitly rather than relying on topological sort, because `e2e`
  devDepends on the driver for its browser-backed integration tests while the
  driver peer-depends on `e2e` — pnpm reports that cycle on every install.
- `pnpm typecheck` runs `build` first, then per-package `typecheck`.
- `pnpm check:spec` typechecks `spec/api` + `spec/examples` under a separate,
  stricter config (`skipLibCheck: false`, DOM lib) — it can fail while package
  typecheck passes.
- Integration tests need Chromium: `pnpm --filter @e2edev/playwright exec
  playwright install chromium`. The driver's `prepare` hook also installs
  missing browsers on first run, before any session launches.

## Non-obvious conventions

- **Relative imports carry the `.ts` extension** (`rewriteRelativeImportExtensions`).
  `import { x } from '../internal/ids.ts'` — not `.js`, not extensionless.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on. Optional
  properties use the conditional-spread idiom; `oxc/no-map-spread` is disabled
  for exactly that reason.
- Lint is `oxlint` with `correctness`/`suspicious`/`perf` as errors and
  `style`/`pedantic` off. `no-await-in-loop` is intentionally off (sequential
  execution is the runner's contract).
- JSDoc on new functions; avoid inline comments unless they explain *why*.

## Testing quirks

- Vitest 4, `pool: 'forks'`, two projects. `integration` is capped at
  `maxWorkers: 3` and runs in a later group — do not raise it; CPU starvation
  produces timeouts indistinguishable from real failures.
- Integration tests write throwaway projects into
  `packages/e2e/tests/tmp-projects/` (gitignored) and import the runner from
  `dist/` via a non-literal specifier so the fixture's `e2e` self-reference
  shares one registry. Stale `dist` means confusing failures — rebuild.
- Testbed suites beyond the default one never gate a PR: `test:public` and
  `test:selenium` (real websites) run in no workflow, and `test:agent` /
  `test:wakacje` / `test:selenium-agent` (real model calls, need
  `E2E_MODEL_API_KEY`, optional `E2E_MODEL=provider/model-id`) run only on the
  weekly `.github/workflows/agent.yml` schedule or by manual dispatch.
  `test:wakacje` and `test:selenium-agent` are non-blocking there: both sites
  are third-party.
- Agentic assertions must be model-portable: assert on meaning (`toContain`)
  and pair each agentic step with a deterministic locator check.

## Gotchas

- Status prose drifts. `packages/e2e/README.md` and `spec/README.md` can claim
  things that have since landed or been removed (the located verbs and the
  locate cache are both gone, for example). Verify against `src/` before
  repeating or relying on any "not implemented yet" list — and fix the prose
  when you find it stale.
- No implicit default model. Agent fixtures without model config fail with
  `MODEL_UNAVAILABLE`; mobile targets are rejected by the v0 boundary.
- Secrets must never reach model input, digests, logs, or reports. Model input
  is the redacted semantic tree plus the bounded ledger only.
- CI (`.github/workflows/spec.yml`) runs Node 26 and pins actions by SHA; keep
  new actions SHA-pinned.
- Commits follow Conventional Commits; PRs are squash-merged with the number in
  the subject.
- Releases go through changesets: a user-visible change adds a `.changeset/`
  entry. Peer ranges point one way only (driver -> `e2e`, widened to `>=x <1`);
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
  outside the driver's `e2e` peer range, which majors `@e2edev/playwright` on
  every runner minor and rewrites the peer range. Widening the range does not
  rescue it — node-semver only lets a prerelease satisfy a comparator set when a
  comparator with the same `major.minor.patch` carries a prerelease, so
  `0.3.0-beta.0` satisfies neither `>=0.1.0-0 <1` nor `*`. Never hand-edit a
  package `version` or `CHANGELOG.md`; `changesets/action` owns both.
- Private packages are skipped entirely by changesets (`privatePackages: false`),
  so `@e2edev/testbed` gets no version bump, no `CHANGELOG.md`, and no git tag.
