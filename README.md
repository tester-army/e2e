<a href="https://tester.army/?utm_source=e2e&utm_medium=github&utm_campaign=readme_banner"><img src="https://github.com/user-attachments/assets/fb0587cc-568e-4ea2-b2ef-19766829af1e" alt="e2e by TesterArmy" width="100%" /></a>

# e2e

e2e is an end-to-end testing framework for web and mobile apps. Describe a goal in natural language and an agent interacts with the app to complete it. Use locators and assertions in the same test to check exact results. Customize anything from agent to the engine.


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
- [`@e2e-dev/web`](./packages/web): the browser engine.
- [`@e2e-dev/mobile`](./packages/mobile): the iOS and Android engine.
- [`@e2e-dev/github`](./packages/github): the pull request comment reporter.
- [`@e2e-dev/integrations`](./packages/integrations): official integrations
  with hosted services, such as Kernel browsers.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).
Apache-2.0, by [TesterArmy](https://tester.army).
