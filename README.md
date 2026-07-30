# e2e

An open, local-first framework for agentic end-to-end testing.

Write tests in ordinary TypeScript. Describe the parts that are tedious to
select in plain language, and keep deterministic control everywhere else.

```ts
import { test } from 'e2e';

test('user can sign up', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the sign up button');
  await agent.assert('the dashboard is visible');
});
```

```bash
pnpm add -D e2e@beta @e2edev/playwright@beta      # web
pnpm add -D e2e@beta @e2edev/agent-device@beta    # iOS and Android
E2E_MODEL=provider/model-id E2E_MODEL_API_KEY=... pnpm e2e run
```

Deterministic suites using `screen`, `app`, `web`, and `expect` need no model.

## Why

Agentic testing should not require surrendering test control, portability, or
diagnostics. Every agent call is a bounded operation you can interleave with
deterministic steps:

```ts
await agent.tap('the Pro plan card');
await screen.getByRole('button', { name: 'Confirm' }).tap();
```

- Your code owns order and values; agent steps stay bounded.
- Waiting, retries, and reports are handled for you.
- Resolved agent steps are cached as readable queries, so repeat runs are fast
  and cheap.
- Credentials never reach the model or the report.
- Runs locally. No account, no hosted runner.

## Documentation

[e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com)

## Packages

- [`e2e`](./packages/e2e) — the SDK, runner, and CLI.
- [`@e2edev/playwright`](./packages/playwright) — the reference web driver,
  loaded on demand by `driver: 'playwright'`.
- [`@e2edev/agent-device`](./packages/agent-device) — the reference mobile
  driver, for iOS simulators and Android emulators.

All three publish under the `beta` dist-tag while the surface stabilizes, so
npm's `latest` is never moved.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

by [TesterArmy](https://tester.army)
