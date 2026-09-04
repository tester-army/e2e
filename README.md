# e2e

An open, local-first framework for agentic end-to-end testing.

Write tests in ordinary TypeScript. Describe the parts that are tedious to
select in plain language, and keep deterministic control everywhere else.

```ts
import { test } from '@e2edev/e2e';

test('user can sign up', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap the sign up button');
  await agent.assert('the dashboard is visible');
});
```

```bash
pnpm add -D e2e@beta @e2edev/playwright@beta
E2E_MODEL=provider/model-id E2E_MODEL_API_KEY=... pnpm e2e run
```

Deterministic suites using `screen`, `app`, `web`, and `expect` need no model.
The runner knows no platform: `@e2edev/playwright` is the browser backend a
web target names in its config, and a device or desktop backend plugs into the
same contract.

## Why

Agentic testing should not require surrendering test control, portability, or
diagnostics. Every agent call is a bounded operation you can interleave with
deterministic steps:

```ts
await agent.act('choose the Pro plan');
await screen.getByRole('button', { name: 'Confirm' }).tap();
```

- Your code owns order and values; agent steps stay bounded.
- Waiting, retries, and reports are handled for you.
- Each passing `agent.act()` records its action trace and the next run
  replays it zero-turn — no model calls — diverging to the live agent
  whenever the app no longer matches. On by default; opt out with
  `cache: 'off'` or `--no-cache`. Judgments are never cached.
- Credentials never reach the model or the report.
- `--ai-trace` records every model call to `.e2e/ai-trace.json`; open it with
  [unbox-ai](https://github.com/tester-army/unbox-ai) to see where the tokens went.
- Runs locally. No account, no hosted runner.

## Documentation

[e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com)

## Packages

- [`e2e`](./packages/e2e) — the SDK, runner, and CLI.
- [`@e2edev/playwright`](./packages/playwright) — the browser backend, passed
  to a target as `backend: playwright()`.
- [`@e2edev/agent-device`](./packages/agent-device) — the mobile backend for
  iOS simulators and Android emulators, `backend: agentDevice({ platform })`.
- [`@e2edev/conversation`](./packages/conversation) — the conversation backend
  for testing an AI agent by talking to it, `backend: conversation({ agent })`.

All publish under the `beta` dist-tag while the surface stabilizes, so npm's
`latest` is never moved.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

by [TesterArmy](https://tester.army)
