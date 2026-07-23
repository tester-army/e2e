# Implementation Plan

Working plan for the next few weeks. The [spec](./spec) is the contract;
this is the order we build it in. Each phase has an exit criterion — no
phase is done until it's proven by use.

## Phase 1 — Cross-platform deterministic API + agent orchestration + runner

Two workstreams. The deterministic API is not an escape hatch — it's the
Playwright/Maestro replacement surface, and [12-migration.md](./spec/12-migration.md)
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
- `defineConfig` (+ `e2e.cloud.config.ts` overlay), `APP_URL` happy path — [05](./spec/05-config.md)
- CLI: `e2e run`, `e2e init` — [06](./spec/06-cli.md)

Deliberately deferred within phase: sessions/`test.setup`, `test.each`,
sharding, `e2e dev`, `e2e open`, resources beyond `credentials` (env-based).

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
- Add what the dogfood forces (likely: `test.setup` + sessions, `email`
  inbox resource for signup flows — [11](./spec/11-lifecycle.md),
  [04](./spec/04-resources.md))

**Exit: TesterArmy CI gates on e2e tests for two weeks without the team
routing around it.**

## Phase 4 — Cloud runner + managed resources

`runner: 'cloud'` as the only switch. — [07](./spec/07-cloud.md)

- Cloud execution of unchanged test files, hosted step-timeline replays
- Managed resources: email inboxes first, then SMS/phone
  ([04](./spec/04-resources.md) shapes are already reserved)
- Shared agent cache + sessions across workers/team
- `e2e login`, `TESTERARMY_TOKEN`, `--cloud`

**Exit: the Phase 3 suite runs in Cloud with zero test-file changes, with
managed inboxes replacing the local catcher.**

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

Principles for the build-out: `api.d.ts` stays normative (implement to it,
change it deliberately); every phase lands with the dogfood suite green;
cut scope before cutting quality.
