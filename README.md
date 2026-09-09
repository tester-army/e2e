# e2e

An open framework for agentic end-to-end testing.

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
pnpm add -D @e2edev/e2e @e2edev/playwright
E2E_MODEL=provider/model-id E2E_MODEL_API_KEY=... npx --no-install e2e run
```

Deterministic suites using `screen`, `app`, `web`, and `expect` need no model.
The runner knows no platform: `@e2edev/playwright` is the browser engine a
web target names in its config, and a device or desktop engine plugs into the
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
- `--video` records every attempt, a WebM in the browser or an MP4 on a
  device, so a failure can be watched instead of reconstructed. Off by
  default.
- Runs locally. No account, no hosted runner. The CLI sends anonymous usage
  counts to improve the framework, never your tests or your app's data;
  `e2e telemetry disable` turns that off
  ([what is sent](https://e2e-docs.vercel.app/telemetry)).

## Documentation

[e2e-docs.vercel.app](https://e2e-docs.vercel.app)

## Coding agents

`e2e init` installs an agent skill into `.agents/skills/` and
`.claude/skills/`, and `npx skills add tester-army/e2e` installs it
anywhere else. Without it, `npx --no-install e2e guide` prints the same text.
See [Coding agents](https://e2e-docs.vercel.app/coding-agents).

## Packages

- [`@e2edev/e2e`](./packages/e2e) — the SDK, runner, and CLI.
- [`@e2edev/playwright`](./packages/playwright) — the browser engine, passed
  to a target as `engine: playwright()`.
- [`@e2edev/agent-device`](./packages/agent-device) — the mobile engine for iOS
  simulators and Android emulators; see the
  [device reference](https://e2e-docs.vercel.app/reference/device).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

---

by [TesterArmy](https://tester.army)
