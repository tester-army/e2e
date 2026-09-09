# @e2edev/web-benchmark

A Next.js app of self-contained scenarios that are hard to automate, and the
e2e suites written against them. This is where we test writing tests with
`e2e`: every scenario isolates one awkward surface (shadow roots, a canvas-only
UI, nested iframes, native dialogs, a second tab, drag and drop, a DOM that
remounts every second, an accessibility tree that lies) so a test either
handles that surface or fails for exactly that reason.

The app under `app/` is copied from `apps/web-benchmark` in the tester-army
monorepo, where the same scenarios gate the autonomous QA agent. Keep diffs
against that source minimal so scenarios port both ways, and never fix a
planted bug.

## Layout

- `app/`: the Next.js project. `app/src/examples.ts` is the catalog: every
  scenario's slug, name, description, and, for bug-book entries, the
  `plantedBug`. One component per scenario in `app/src/Examples/`, served at
  `/e/<slug>`; the home page lists them all.
- `e2e.config.ts` + `tests/`: the deterministic suite. Gates every PR.
- `e2e.agent.config.ts` + `tests-agent/`: the agentic suite, derived from the
  deterministic config. Spends real model calls, so it runs on the weekly
  `.github/workflows/agent.yml` schedule, never on a PR.

## Commands

Build the runner first; the suites run the built `@e2edev/e2e` CLI by path, like
the testbed does: pnpm links no `e2e` bin for a workspace package whose `dist`
does not exist yet at install time, and CI installs before it builds.

```bash
pnpm build                                          # from the repo root, once
pnpm --filter @e2edev/web-benchmark test            # build the app, run tests/
pnpm --filter @e2edev/web-benchmark test:headed
E2E_MODEL_API_KEY=... pnpm --filter @e2edev/web-benchmark test:agent
pnpm --filter @e2edev/web-benchmark dev             # browse the scenarios on :4280
```

### Writing tests

`test` rebuilds the production app on every run. While authoring, keep the dev
server up instead: the config sets `reuseExisting`, so outside CI a server
already answering on port 4280 is used as is and nothing is started or
stopped. Run one file at a time from the package directory:

```bash
pnpm --filter @e2edev/web-benchmark dev
cd packages/web-benchmark
node node_modules/@e2edev/e2e/dist/cli/bin.js run tests/login-form.e2e.ts --headed
```

Two things bite here:

- Role names match exactly by default. The home page links are named after the
  scenario name and its description, so `getByRole('link', { name: 'Login
  Form', exact: false })` is the query that finds one. See `tests/smoke.e2e.ts`.
- `reuseExisting` trusts whatever answers on the port. A dev server left
  running from another checkout serves that checkout's scenarios.

Reports land in `.e2e/report.json`, artifacts under `.e2e/artifacts/`, both
ignored.

## Scenario contract

Task scenarios end in a deterministic success state. Where the DOM semantics
are intact, the terminal element carries `data-testid="success-message"`; the
adversarial scenarios (Canvas Only, Canvas Whiteboard, Div Soup, Aria Hidden
Flow, Image Only UI, CSS Content UI, Onboarding Wizard) omit test ids and
semantics on purpose, so success is only visible in pixels.

Bug-book scenarios (registry entries with `plantedBug`) contain exactly one
deterministic product bug, marked `PLANTED BUG (do not fix)` in source, and
the rest of the flow works. A test asserting the correct behavior must fail
there, which is how we check that an assertion or an `agent.assert` judgment
catches a real bug instead of passing over it. Promo Storefront and Gift Card
Purchase are traps: bug-looking artifacts (overlays, a chat widget, aria labels
that read "undefined") that are not defects, so a correct test passes.

The Login Form account is declared as the `benchmark` credential in
`e2e.config.ts`, so tests reach it through `credentials.user('benchmark')` and
agent steps fill the password through the secret tool without the model ever
seeing it.

## Adding a scenario

Create `app/src/Examples/YourCase.tsx`, register it in `app/src/examples.ts`
(the doc comment there states the rules for task and bug-book entries), and
write its tests in `tests/` or `tests-agent/`. Pair every agentic step with a
deterministic check so a wrong judgment cannot pass silently.
