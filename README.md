<a href="https://tester.army/e2e?utm_source=e2e&utm_medium=github&utm_campaign=readme_banner"><img src="https://raw.githubusercontent.com/tester-army/e2e/main/.github/assets/readme-banner.png" alt="e2e by TesterArmy" width="100%" /></a>

<p align="center">
  <a href="https://tester.army?utm_source=e2e&utm_medium=github&utm_campaign=readme_badge"><img alt="Made by TesterArmy" src="https://raw.githubusercontent.com/tester-army/e2e/main/.github/assets/made-by-testerarmy.svg" /></a>
  <a href="https://www.npmjs.com/package/e2e"><img alt="npm version" src="https://img.shields.io/npm/v/e2e.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://github.com/tester-army/e2e/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://tester.army/discord"><img alt="Join the community on Discord" src="https://img.shields.io/badge/Join%20the%20community-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white&labelColor=000000" /></a>
</p>

# e2e

[e2e](https://tester.army/e2e?utm_source=e2e&utm_medium=github&utm_campaign=readme_intro) is an end-to-end testing framework for web and mobile apps. Describe a goal in natural language and an agent interacts with the app to complete it. Use locators and assertions in the same test to check exact results. Customize anything from agent to the engine.


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

- [`e2e`](https://github.com/tester-army/e2e/tree/main/packages/e2e): SDK, runner, and CLI.
- [`@e2e-dev/web`](https://github.com/tester-army/e2e/tree/main/packages/web): the browser engine.
- [`@e2e-dev/mobile`](https://github.com/tester-army/e2e/tree/main/packages/mobile): the iOS and Android engine.
- [`@e2e-dev/github`](https://github.com/tester-army/e2e/tree/main/packages/github): the pull request comment reporter.
- [`@e2e-dev/kernel`](https://github.com/tester-army/e2e/tree/main/packages/kernel): Kernel hosted browsers for the web
  engine.
- [`@e2e-dev/eas`](https://github.com/tester-army/e2e/tree/main/packages/eas): EAS Simulators hosted iOS simulators and
  Android emulators for the mobile engine.

## Contributing

See [CONTRIBUTING.md](https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/tester-army/e2e/blob/main/SECURITY.md).
Apache-2.0.

Built by [TesterArmy](https://tester.army/?utm_source=e2e&utm_medium=github&utm_campaign=readme_footer),
the agentic testing platform that runs plain-English tests on web and mobile
apps and reports back with screenshots and recordings.
