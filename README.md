# e2e

Agentic end-to-end testing framework for any app.

Describe what a user does in natural language, pin the exact outcome with
locators and assertions, and run it like any other test suite. Web runs
through Playwright, iOS and Android through agent-device, and anything else
with a UI through the same engine contract.

```ts
// tests/checkout.e2e.ts
import { test, expect } from 'e2e';

test('a member upgrades to Pro', async ({ app, agent, screen }) => {
  await app.open('/settings/billing');

  await agent.act('upgrade the workspace to the Pro plan');
  await agent.assert('the invoice preview shows a prorated amount');

  await expect(screen.getByRole('status')).toContainText('Pro');
});
```

```bash
npx e2e init
```

An agent step that a later assertion verifies records its actions, and the
next run replays them with no model calls until the app changes. Tests
without agent steps need no model. Bring your own subscription, API key, or
local model.

## Documentation

[e2e.tester.army/docs](https://e2e.tester.army/docs): quickstart, writing
tests, mobile, migrating from Playwright, Cypress, Selenium, Detox, or
Maestro, and the full reference.

## Packages

- [`e2e`](./packages/e2e): SDK, runner, and CLI.
- [`@e2edev/playwright`](./packages/playwright): the browser engine.
- [`@e2edev/agent-device`](./packages/agent-device): the iOS and Android engine.
- [`@e2edev/github`](./packages/github): the pull request comment reporter.
- [`@e2edev/oauth`](./packages/oauth): sign in with a ChatGPT, GitHub Copilot,
  or SuperGrok subscription.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).
Apache-2.0, by [TesterArmy](https://tester.army).
