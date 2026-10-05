<a href="https://tester.army/e2e?utm_source=e2e&utm_medium=github&utm_campaign=readme_banner"><img src="./.github/assets/readme-banner.png" alt="e2e, the open source AI testing framework by TesterArmy" width="100%" /></a>

<p align="center">
  <a href="https://tester.army?utm_source=e2e&utm_medium=github&utm_campaign=readme_badge"><img alt="Made by TesterArmy" src="./.github/assets/made-by-testerarmy.svg" /></a>
  <a href="https://www.npmjs.com/package/e2e"><img alt="npm version" src="https://img.shields.io/npm/v/e2e.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://tester.army/discord"><img alt="Join the community on Discord" src="https://img.shields.io/badge/Join%20the%20community-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white&labelColor=000000" /></a>
</p>

<p align="center">
  <a href="https://www.star-history.com/tester-army/e2e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=tester-army/e2e&type=trending&theme=dark" /><img alt="GitHub Trending Repository of the Day" src="https://api.star-history.com/badge?repo=tester-army/e2e&type=trending" /></picture></a>
</p>

# e2e

[e2e](https://tester.army/e2e?utm_source=e2e&utm_medium=github&utm_campaign=readme_intro) is an end-to-end testing framework for web and mobile apps. Describe a goal in natural language and an agent drives the app to reach it. Check the result with locators and assertions in the same test.

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

An agent step that a later assertion verifies records its actions, and the
next run replays them with no model calls until the app changes. Tests
without agent steps need no model. Bring your own subscription, API key, or
local model.

## Quick start

```bash
npx e2e init
```

`init` asks for an engine, web or mobile, and a model provider, then writes a
config and an example test. The
[quickstart](https://e2e.tester.army/docs/quickstart) covers the rest.

To see a finished setup in your stack, open
[`examples/`](https://github.com/tester-army/e2e/tree/main/examples):
The Vite example is a standalone project with a passing
suite.

## Packages

| Package | What it does |
| --- | --- |
| [`e2e`](https://www.npmjs.com/package/e2e) | The SDK, runner, and CLI. |
| [`@e2e-dev/web`](https://www.npmjs.com/package/@e2e-dev/web) | Browser engine: Chromium, Firefox, and WebKit through Playwright. |
| [`@e2e-dev/mobile`](https://www.npmjs.com/package/@e2e-dev/mobile) | iOS and Android engine: simulators and emulators through agent-device. |
| [`@e2e-dev/github`](https://www.npmjs.com/package/@e2e-dev/github) | Reporter that posts results as a pull request comment. |
| [`@e2e-dev/kernel`](https://www.npmjs.com/package/@e2e-dev/kernel) | Kernel hosted browsers for the web engine. |
| [`@e2e-dev/eas`](https://www.npmjs.com/package/@e2e-dev/eas) | EAS Simulators hosted iOS simulators and Android emulators for the mobile engine. |
| [`@e2e-dev/decision`](https://e2e.tester.army/docs/decision-models) | Decision-model executors for bounded semantic actions and assertions. |

## Documentation

[e2e.tester.army/docs](https://e2e.tester.army/docs). The `e2e` package ships
every page, so coding agents can read them offline in `node_modules/e2e/docs`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Questions go to
[Discord](https://tester.army/discord).

## Security

Please don't open public issues for security vulnerabilities. Follow
[SECURITY.md](./SECURITY.md) and report them to
[security@tester.army](mailto:security@tester.army).

## Telemetry

The CLI sends anonymous usage data, such as which commands and engines run and
where runs fail, but no test content, app content, or credentials. Opt out with
`npx e2e telemetry disable` or `E2E_TELEMETRY_DISABLED=1`.
[Telemetry](https://e2e.tester.army/docs/telemetry) lists every field.

## Status

> [!NOTE]
> e2e is in active development on the way to 1.0. APIs and config can still
> change between minor releases.

## Made by TesterArmy

e2e is built by [TesterArmy](https://tester.army/?utm_source=e2e&utm_medium=github&utm_campaign=readme_footer),
the agentic testing platform that runs natural language tests on web and mobile
apps, on every pull request or on a schedule.

Apache-2.0.
