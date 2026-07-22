# 11 — Lifecycle, Groups, Sessions, Parameterization

The table-stakes primitives every serious framework has, adapted to e2e's
model.

## Setup and teardown

Four layers, from widest to narrowest scope:

| Layer | API | Runs |
|---|---|---|
| Global | `globalSetup` / `globalTeardown` in config | once per run, before/after everything |
| Setup tests | `test.setup()` | once per run, before dependent tests; produce sessions |
| File/group | `test.beforeAll` / `test.afterAll` | once per file or group |
| Test | `test.beforeEach` / `test.afterEach` | around every test |

### Global setup/teardown

```ts
// e2e.config.ts
export default defineConfig({
  globalSetup: './e2e.setup.ts',
  globalTeardown: './e2e.teardown.ts',
});
```

```ts
// e2e.setup.ts — plain async function, full access to resources
export default async function () {
  await seedDatabase();
}
```

Runs in one process before workers start. For app state seeding, external
provisioning, service warmup. Teardown always runs, even on failure/abort.

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

- Group options (`tags`, `session`, `platforms`, `timeout`, `retries`) apply
  to every test inside; test-level options override.
- Groups nest; hooks declared inside a group scope to it.

### Serial mode

```ts
test.describe.serial('onboarding wizard', () => {
  test('step 1: company info', /* … */);
  test('step 2: invite team', /* … */);
  test('step 3: finish', /* … */);
});
```

- Tests run in order, in the same worker, sharing the browser/app state.
- A failure skips the remainder of the group.
- This is the escape hatch for genuinely sequential flows — independent
  tests stay the default and parallelize freely.

## Parameterization — `test.each`

```ts
test.each([
  { plan: 'starter', price: 900 },
  { plan: 'pro', price: 2900 },
  { plan: 'enterprise', price: 9900 },
])('user can buy the $plan plan', async ({ agent }, { plan, price }) => {
  await agent.act(`buy the ${plan} plan with the test card`);
  await agent.assert(`the receipt shows $${price / 100} charged`);
});
```

- Each case is a separate test result; `$key` interpolation in titles.
- Cases must be statically known (no async case factories) so listing/
  sharding stays deterministic.

## Conditional skips

```ts
test.skipIf(!process.env.BILLING_ENABLED)('checkout works', async ({ agent }) => { /* … */ });
test.failsIf(process.env.CI)('flaky on CI, tracked in #123', /* … */);
```

- `skipIf(condition)` — skip with the condition source as reason.
- `failsIf(condition)` — expected failure: passes report as "expected fail",
  unexpected pass fails the test (keeps known bugs visible without red CI).

## Custom fixtures — `test.extend()` (reserved, post-v0)

Playwright-proven model, reserved shape:

```ts
// fixtures.ts
import { test as base } from 'e2e';

export const test = base.extend<{ tenant: Tenant }>({
  tenant: async ({}, use) => {
    const tenant = await createTenant();      // setup
    await use(tenant);                        // provide to test
    await deleteTenant(tenant.id);            // teardown, always runs
  },
});
```

Fixtures are lazy (created only if the test uses them) and torn down in
reverse order. This is also the intended home for the app-state seeding
story (per-test tenants, DB fixtures).

## Sharding

```bash
npx e2e run --shard 1/4
```

Deterministic test-to-shard assignment based on the full test list (file +
title + target). GitHub Actions matrix example ships in docs. Cloud runner
shards automatically — `--shard` is for self-hosted CI.

## Watch mode

```bash
npx e2e dev            # watch files, re-run affected tests, headed browser
npx e2e dev tests/checkout.e2e.ts
```

Dev loop: keeps the browser/app alive between runs, re-runs on file change,
`agent` path cache warm. This is the local authoring experience; `run`
stays the CI-shaped command.

## Considered and deferred

- **Network interception**: a cross-platform request-routing primitive may
  come later if it earns its place; service emulation (roadmap) is the
  intended answer for third parties.
- **Clock control**: valuable (trials expiring, cron UIs); needs a
  cross-driver design. Roadmap.
- **Custom reporter SPI**: config `reporters` accepts built-ins now
  (`list`, `json`, `github`); a documented SPI comes post-v0.
