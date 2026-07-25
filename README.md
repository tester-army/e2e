# e2e

An open, local-first standard for agentic end-to-end testing.

The specified v0 runs web tests through a reference Playwright driver. The portable API and
driver model are designed for future iOS and Android profiles without claiming
mobile support before those profiles pass conformance.

The following is the locked usage contract. A reference implementation of the
deterministic surface lives in [`packages/e2e`](./packages/e2e).

```ts
import { test } from 'e2e';

test('user can sign up', async ({ app, agent }) => {
  await app.open();
  await agent.act('sign up as a new user');
  await agent.assert('the dashboard is visible');
});
```

```bash
E2E_MODEL=provider/model-id E2E_MODEL_API_KEY=... pnpm e2e run
```

Deterministic suites using `screen`, `app`, `web`, and `expect` need no model.

## Why

Agentic testing should not require surrendering test control, portability, or
diagnostics. e2e makes each agent call a bounded operation inside ordinary
TypeScript and lets deterministic semantic actions interleave with it:

```ts
await agent.act('open billing and start an upgrade');
await agent.tap('the Pro plan card');
await screen.getByRole('button', { name: 'Confirm' }).tap();
```

- Code owns order and values; agents are bounded fixtures.
- The runner owns waiting, retries, policy, caching, and reports.
- Drivers implement a versioned query/action/observation/state contract.
- Credentials remain opaque to models and reports.
- Locate caches become readable semantic queries; path caches remain guarded
  model guidance rather than blind replay.
- Reports, caches, and sessions use versioned schemas.
- Local execution requires no e2e account or hosted runner.

## Standard

The frozen specification is under [`spec/`](./spec):

- [`spec/00-conformance.md`](./spec/00-conformance.md) defines profiles and
  conformance;
- [`spec/api/`](./spec/api) contains canonical TypeScript declarations;
- [`spec/schema/`](./spec/schema) contains canonical wire schemas;
- [`spec/14-security.md`](./spec/14-security.md) defines mandatory safety
  behavior;
- [`spec/12-migration.md`](./spec/12-migration.md) documents migration coverage
  without claiming unsupported parity.

## Status

Specification 0.1 is the implementation baseline. v0 consists of every required
profile listed in [`spec/00-conformance.md`](./spec/00-conformance.md). The
normative release gate is in [`spec/07-scope.md`](./spec/07-scope.md);
[`PLAN.md`](./PLAN.md) only orders implementation work.

Phase 1 implementation is in progress in this repository, a pnpm monorepo:

- [`packages/e2e`](./packages/e2e) — the `e2e` package: sdk-0.1 deterministic
  surface (`test`, `expect`, `screen`, `app`, `web`, sessions), the runner and
  CLI, the `e2e/driver` SPI, and the `e2e/playwright` reference driver.

Agentic execution (`agent.*`), caching, and the HTML reporter are not
implemented yet; acquiring the `agent` fixture fails with `MODEL_UNAVAILABLE`
as specified. Mobile targets are rejected per the v0 boundary.

Deferred mobile, resource, PR, service, and hosted-runner designs live under
[`spec/roadmap/`](./spec/roadmap) and are nonnormative.

---

by [TesterArmy](https://tester.army)
