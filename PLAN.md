# Implementation Plan

Working plan for the next few weeks. The [spec](./spec) is the contract;
this is the order we build it in. Each phase has an exit criterion — no
phase is done until it's proven by use.

## Phase 1 — Cross-platform deterministic API + agent orchestration + runner

Two workstreams. The deterministic API is not an escape hatch — it's the
Playwright/Maestro parity surface, and [12-migration.md](./spec/12-migration.md)
is its checklist (every ✅ row must work; P1 rows are the fast-follow list).

**Workstream A — deterministic surface** (web driver first):
- `screen` queries + gestures (`swipe`, `scrollUntilVisible`) + full
  `Locator` action/read set — [08](./spec/08-platforms.md)
- `web`: navigation, `locator(css)`, `route()`/network, cookies, dialogs,
  downloads, `evaluate`, keyboard/mouse — [08](./spec/08-platforms.md)
- `app` lifecycle (`open/restart/clearState/back`), `expect(locator)` +
  `expect(web)` matchers — [03](./spec/03-assertions.md)
- `e2e/playwright` as the first driver behind the SPI — [09](./spec/09-drivers.md)

**Workstream B — agent + runner:**
- `test()`, hooks, `test.describe` (+ `serial`), fixtures wiring — [02](./spec/02-test-api.md)
- Runner: discover `tests/**/*.e2e.ts`, execute, report (list reporter),
  exit codes — [06](./spec/06-cli.md)
- Agent orchestration: bounded sub-agent per `agent.*` call, step ledger,
  handoff compaction, ambient context — [10](./spec/10-determinism.md)
- `agent.act` (+ typed `schema` output) /`assert/extract/login` + instant
  actions (`tap/type/scroll/scrollTo/longPress/waitFor`) — [02](./spec/02-test-api.md)
- `defineConfig`, `APP_URL` happy path — [05](./spec/05-config.md)
- CLI: `e2e run`, `e2e init` — [06](./spec/06-cli.md)

Deliberately deferred within phase: sessions/`test.setup` land in Phase 3;
resource extensions (email first), `test.each`, sharding, `e2e dev`,
`e2e open` are post-v0 ([spec/roadmap](./spec/roadmap/README.md)).

**Exit: (a) a Playwright test of moderate complexity ports 1:1 using the
migration table with no dead ends; (b) a signup-style test with mixed
`act`/instant/`screen` steps passes locally against a real app.**

## Phase 2 — Caching layer + replay system

Agentic once, near-deterministic after. — [10](./spec/10-determinism.md)

- Locate cache: instant-action targets → `screen`-shaped queries in
  `.e2e/cache`, committable, validated on replay, AI fallback on mismatch
- Path cache: `act()` traces as guidance; no mid-flow write-backs; cleared
  on failure; bypassed on retries
- `--no-agent-cache`, config `agent.cache`
- Replay/report artifacts: step timeline (JSON + basic HTML), screenshots
  per step, `AgentError.code` taxonomy

**Exit: second run of the same suite is measurably faster/cheaper (target:
zero model calls on unchanged UI for instant actions) and the cache diff is
human-readable in a PR.**

## Phase 3 — Dogfood: TesterArmy on e2e, locally + GitHub Actions

- Write the TesterArmy web app's own suite in `e2e`
- GitHub Actions workflow (`npx e2e run` on PRs), artifacts uploaded
- Fix what hurts: flakiness, error messages, report quality, CI ergonomics
- Add what the dogfood forces (likely: `test.setup` + sessions —
  [11](./spec/11-lifecycle.md); `e2e dev` if the authoring loop hurts —
  the Vitest lesson says the inner loop is the retention engine; the
  `email` extension only if signup flows demand it)

**Exit: TesterArmy CI gates on e2e tests for two weeks without the team
routing around it.**

## Phase 4 — Cloud runner + managed resources

Promote [roadmap/cloud.md](./spec/roadmap/cloud.md) into the spec,
re-validated against the by-then-real core API. `runner: 'cloud'` as the
only switch.

- Cloud execution of unchanged test files, hosted step-timeline replays
- Resource extensions, local + managed: email inboxes first, then
  SMS/phone ([04](./spec/04-resources.md) shapes are reserved)
- Shared agent cache + sessions across workers/team
- `e2e login`, `TESTERARMY_TOKEN`, `--cloud`

**Exit: the Phase 3 suite runs in Cloud with zero test-file changes, with
managed resource backends swapped in via config.**

## Phase 5 — iOS/Android platforms

Cross-platform promise, cashed in. — [08](./spec/08-platforms.md)

- `e2e/agent-device` driver: simulators/emulators, a11y-tree observation,
  `screen` projection, `app`/`device` fixtures
- Targets matrix, `--target`, per-target sessions and reports
- Dogfood on a real RN app

**Exit: one portable test file passes on web + iOS + Android targets.**

## Phase 6 — Services (emulation layer)

Promote [roadmap/service-emulation.md](./spec/roadmap/service-emulation.md)
into the spec, re-validated against the by-then-real core API.

- `services` fixture, Stripe + email-send capture first, Slack second
- Service matchers (`expect(stripe).toHavePayment(…)`)
- `e2e services` CLI, per-run isolation; managed sandboxes in Cloud

**Exit: a checkout test asserts against emulated Stripe locally and a
managed sandbox in Cloud, same file.**

---

## The Vitest playbook

Vitest became the greenfield default over Jest in ~3 years (State of JS
2025: ~96% vs <70% satisfaction). Its mechanics, mapped onto e2e — with
the caveat that Playwright is a healthy incumbent (91% satisfaction), so
the opportunity is the authoring layer, never the automation engine:

1. **Absorb the engine, don't fight it.** Vitest reused Vite's pipeline
   instead of rebuilding Babel. e2e ships Playwright as the default driver
   — its excellence becomes ours; the driver SPI keeps us unmarried.
2. **Solve structural pain, not features.** Jest's CJS core couldn't
   follow ESM. Playwright's selector-first, web-only model doesn't aim at
   agent-native execution, cross-platform targets, or managed resources —
   that's a different product. Position there, only there.
3. **Compatibility makes switching an afternoon.** Vitest's Jest-compat API
   + codemods meant migrations were mechanical, and coexistence (new tests
   first, dual CI, sunset) de-risked adoption.
   [12-migration.md](./spec/12-migration.md) is our version; an
   `e2e migrate` codemod is roadmap. Bonus: models trained on Playwright
   emit near-valid e2e code — compat neutralizes "the AI doesn't know it".
4. **The inner loop is the retention engine.** Vitest's ~100ms watch reruns
   produced ~98% retention, and retention produced the defaults. Our
   equivalents: instant actions replaying from cache as `screen` calls,
   warm sessions, and eventually `e2e dev`. Watch Phase 3 for this.
5. **Zero config, deletion as the reward.** TS/ESM-native runner, no
   transform ceremony, auto browser install — migrating from Playwright
   should mean deleting config, not porting it.
6. **Distribution is defaults.** Vitest won via framework starter
   templates. Our channel is coding agents: `e2e init` writing AGENTS.md
   guidance, skills, llms.txt, machine-readable reports.

## The moat

Against hosted AI-testing products, the core defensibility is being the
open standard, not a better SaaS. The stack, in order:

1. **Distribution over sales.** A framework is adopted by `npm install`
   and a PR — no procurement, no pilot. Coding agents amplify the
   asymmetry: they scaffold what's installable, never what's sold.
2. **Survivability trust.** Teams won't gate merges on a startup's
   proprietary runner that may vanish. Local-first OSS deletes the
   mortality objection — if we disappear, suites keep running. No hosted
   competitor can copy this without becoming us.
3. **Format ownership.** Tests written in the e2e API live in repos, CI,
   and review; committed caches ride along. That corpus compounds into
   switching costs — and switching costs accrue to the API owner, not
   the dashboard vendor.
4. **Ecosystem leverage.** The driver SPI and resource-extension model
   let the community build platforms and backends no startup roadmap
   staffs.
5. **Training-data flywheel.** Public OSS teaches the models; the models
   then write e2e by default. Proprietary DSLs are invisible to this
   loop.
6. **Revenue rides the standard** (roadmap/cloud.md) — monetize
   convenience on top, never capability inside. The Vercel/Next.js shape.

What the bet requires, honestly:

- **Adoption is the precondition, not the product.** A dead OSS framework
  defends nothing. Phases 1–3 exist to earn adoption before anything is
  monetized.
- **Speed is existential.** OSS-standard is winner-take-most; the
  position holds only if we're the schelling point before a hosted
  competitor open-sources a runner or an incumbent extends scope.
- **Permissive license means others may host e2e before we do.**
  Accepted — the counter is being upstream and shipping the reserved
  cloud design when ready, never license games.
- **Two fronts, two weapons.** OSS is the moat against startups; against
  incumbent frameworks the moat is scope (cross-platform + agent-native
  runner). Don't mix the arguments.

---

Principles for the build-out: the spec stays normative (implement to it,
change it deliberately); every phase lands with the dogfood suite green;
cut scope before cutting quality.
