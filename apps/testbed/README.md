# @e2e-dev/testbed

Dogfood workspace for the [`e2e`](../../packages/e2e) runner: a real project consuming the
built `e2e` package exactly like a user would, against playground apps we
control. This is where every runner feature has a deterministic test. Hard UI
surfaces live in the benchmarks (`web-benchmark`, `mobile-benchmark`), not
here.

## Layout

- `app/server.mjs` — dependency-free playground app. The runner starts and
  stops it via the web engine's `command` option. The pages live under
  `app/pages/` by group, each module exporting its routes and its nav
  entries: `basics` (home, todos, forms, login/session, dashboard, wizard),
  `interaction` (network, dialogs, board, pointer pad, iframes), `canvas`
  (four pixels-only surfaces), `downloads` (a file and a long page), and
  `controls` (control states, scrolling, the browser fixture's page, the
  speed counter, about). `app/pages/index.mjs` merges them and
  `app/layout.mjs` renders the nav from that registry.
- `app/bug-garden.mjs` — a bookshop with planted defects, for `e2e explore`.
- `dogfood/server.mjs` — an expense-claims app with a test API, for the
  executor dogfoods.
- `e2e.config.ts` + `tests/` — the local suite, gating every PR: queries,
  actions, polling assertions, sessions (`test.setup` + `session:`), serial
  groups, routes, dialogs, frames, downloads, uploads, keyboard input,
  credentials and secrets, plus one file per surface added since: control
  states and the failure codes (`controls`), pointer coordinates and path
  swipes (`pointer`), viewport and node scrolling (`scroll`), the `browser`
  fixture's own verbs (`browser`), and the per-action speed floor (`speed`).
  `tests/helpers.ts` holds the shared `failure`, `boxOf`, and `centerOf`.
- `e2e.agent.config.ts` + `tests-agent/` — opt-in agentic suite against the
  playground: `agent.act` flows, assisted polling, judgments,
  schema-validated extraction with zod, and the pixel tools on the canvas
  pages. `e2e.mixed.config.ts` adds the local suite to it for watching the
  list reporter interleave the two.
- `e2e.dogfood.config.ts` + `tests-dogfood/` — the built-in agent extended
  with project tools (seed and reset over the expense app's test API).
- `e2e.dogfood-brain.config.ts` + `tests-dogfood-brain/` — a hand-rolled
  `StepExecutor` with its own tools and transport; the engine is never touched.
- `e2e.dogfood-edge.config.ts` + `tests-dogfood-edge/` — steps expected to
  conclude blocked or failed; the report, not the exit code, is the output.
- `e2e.stress.config.ts` + `tests-stress/` — failures, timeouts, skips,
  flakes, and hostile titles for the reporters.
- `e2e.explore.config.ts` + `scripts/explore-bench.mjs` — `e2e explore`
  against the bug garden, and a scorer that runs it across models.
- `e2e.scratch.config.ts` + `tests-scratch/` — a scratch agent config for
  one-off investigations with the AI SDK devtools recorder.

## Commands

```bash
pnpm --filter e2e build               # the testbed runs the built runner
pnpm --filter @e2e-dev/testbed test    # typecheck + local suite (starts the app itself)
pnpm --filter @e2e-dev/testbed test:headed
pnpm --filter @e2e-dev/testbed app     # run the playground manually
AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:agent     # real model calls
AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:dogfood
AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed explore:garden
pnpm --filter @e2e-dev/testbed test:stress                            # reporters only
```

The local suite runs in CI on every push. Reports land in `.e2e/report.json`;
artifacts and trace pages under `.e2e/results/`.

## Agentic suites

`test:agent` and `test:dogfood` spend real model calls, so they never gate a
PR: they run on the weekly `.github/workflows/agent.yml` schedule, by manual
dispatch, or by hand. Each config builds its model with the AI SDK's
`gateway()`, pins `openai/gpt-6-luna-fast`, and honours the testbed's own
`E2E_MODEL` variable so the same suite can be replayed across providers:

```bash
AI_GATEWAY_API_KEY=...  pnpm --filter @e2e-dev/testbed test:agent
E2E_MODEL=openai/gpt-6-luna-fast AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:agent
```

Agentic assertions are structurally comparable across models, not textually
identical, so these tests assert on meaning (`toContain`) and pair every
agentic step with a deterministic locator check.

To see where the tokens went, record the run and open the trace in
[unbox-ai](https://github.com/tester-army/unbox-ai):

```bash
AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:agent -- --ai-trace
npx unbox-ai .e2e/ai-trace.json          # viewer: treemap, waterfall, diffed turns
npx unbox-ai runs .e2e/ai-trace.json     # one line per agent step, from the terminal
```

To watch calls land while the suite runs, `e2e.agent.config.ts` registers the
AI SDK devtools recorder when `E2E_DEVTOOLS` is set; start the live viewer
first, in this directory:

```bash
npx unbox-ai devtools                    # live viewer on http://localhost:4983
E2E_DEVTOOLS=1 AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/testbed test:agent -- --workers 1
```

The devtools recorder names runs after their first prompt and keeps one
database per process, hence `--workers 1`; the `--ai-trace` file names runs
after the test and step and merges every worker, so use it for anything you
want to keep or compare.

## Hazards worth knowing

- `fill` on a rich-text host resolves successfully and changes nothing (the
  editor reverts it): a silent no-op only a paired deterministic assertion
  catches.
- `instanceof` across a frame boundary is always false: an element inside an
  iframe belongs to that frame's realm, so `field instanceof HTMLInputElement`
  in a `browser.evaluate` silently takes the else branch.
- Agentic assertions must be answerable from one observation. A screenshot
  cannot show recurrence, so assert state, not history.
- String text matching is **exact by default**, inverting the Playwright and
  Testing-Library default.
