# e2e

Agentic end-to-end testing framework for any app: the SDK, runner, and CLI.
Documentation: [e2e.tester.army/docs](https://e2e.tester.army/docs).

```bash
npx e2e init
```

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

A target names its engine: [`@e2edev/web`](https://www.npmjs.com/package/@e2edev/web)
for the web, [`@e2edev/mobile`](https://www.npmjs.com/package/@e2edev/mobile)
for iOS and Android. An agent step that a later assertion verifies records
its actions, and the next run replays them with no model calls until the app
changes. Tests without agent steps need no model.

Not available yet: an HTML reporter.

Source, issues, and [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md):
[github.com/tester-army/e2e](https://github.com/tester-army/e2e).
