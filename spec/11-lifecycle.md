# 11 — Lifecycle, Groups, Sessions

The table-stakes primitives every serious framework has, adapted to e2e's
model — kept to the v0 minimum.

## Setup and teardown

Three layers, from widest to narrowest scope:

| Layer | API | Runs |
|---|---|---|
| Setup tests | `test.setup()` | once per run, before dependent tests; produce sessions |
| File/group | `test.beforeAll` / `test.afterAll` | once per file or group |
| Test | `test.beforeEach` / `test.afterEach` | around every test |

### Setup tests — `test.setup()`

A setup test is a real test (agent, fixtures, artifacts, reporting) whose
job is to produce shared state — typically an authenticated **session**:

```ts
// tests/auth.setup.e2e.ts
import { test, credentials } from 'e2e';

export default test.setup('authenticate as admin', async ({ agent, session }) => {
  await agent.login(credentials.user('admin'));
  await session.save('admin');
});
```

```ts
// tests/invite.e2e.ts — starts already logged in
export default test('admin invites teammate', { session: 'admin' }, async ({ agent }) => {
  await agent.act('invite a teammate as viewer');
  await agent.assert('the invite was sent');
});
```

Semantics:

- Setup tests run first, once per run. Tests referencing `session: 'name'`
  implicitly depend on the setup test that saved it.
- If a setup test fails, dependent tests are reported as skipped with the
  setup failure as cause — not as their own failures.
- Setup tests are matched by `tests/**/*.setup.e2e.ts` (or `test.setup()` in
  any file).

## `session` — saved app state

Cross-platform state capture, resource-style:

```ts
type Session = {
  /** Capture current state under a name (web: cookies/localStorage/IndexedDB; mobile: app data). */
  save(name: string): Promise<void>;
  /** Restore mid-test (rare; prefer the `session` test option). */
  restore(name: string): Promise<void>;
};
```

- The `session` test/group option restores state **before** the test starts —
  the fast path.
- Locally sessions persist in `.e2e/sessions` (re-login only when expired);
  in Cloud they are per-run, shared across workers, and encrypted.
- Session names are per-target: `admin` on `web` and `admin` on `ios` are
  captured independently by running the setup test per target.

## Groups

`test.describe` with options and modes:

```ts
test.describe('billing', { tags: ['billing'], session: 'admin' }, () => {
  test('checkout works', async ({ agent }) => { /* … */ });
  test('invoice email arrives', async ({ agent }) => { /* … */ });
});
```

- Group options (`tags`, `session`, `platforms`, `timeout`, `retries`,
  `agentContext`, `serial`) apply to every test inside; test-level options
  override — except `tags`, which union, and `agentContext`, which
  concatenates.
- Groups nest; hooks declared inside a group scope to it.

### Serial mode

```ts
test.describe('onboarding wizard', { serial: true }, () => {
  test('step 1: company info', /* … */);
  test('step 2: invite team', /* … */);
  test('step 3: finish', /* … */);
});
```

- Tests run in order, in the same worker, sharing the browser/app state.
- A failure skips the remainder of the group.
- This is the escape hatch for genuinely sequential flows — independent
  tests stay the default and parallelize freely.

## Deferred to post-v0

Designed but deliberately out of the v0 core (see roadmap/ for the parked
shapes):

- **`globalSetup` / `globalTeardown`** — config-level run hooks for DB
  seeding and provisioning.
- **`test.each`** — parameterized tests with `$key` title interpolation.
- **`test.skipIf` / `test.failsIf` / `test.fixme`** — conditional skips and
  expected failures.
- **`test.extend()`** — Playwright-style custom fixtures with lazy
  setup/teardown; the intended home for per-test tenants and DB fixtures.
- **Sharding (`--shard n/total`)** — deterministic CI fan-out.
- **Watch mode (`e2e dev`)** — the local authoring loop.
- **Network interception (cross-platform)**: may come later if it earns its
  place; service emulation (roadmap) is the intended answer for third
  parties.
- **Clock control**: valuable (trials expiring, cron UIs); needs a
  cross-driver design.
- **Custom reporter SPI**: v0 ships `list` and `json` built-ins only.
