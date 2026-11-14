# e2e-core

Drive a browser or a native app from code, the way `playwright-core` drives a
browser. `e2e-core` is the [e2e](https://github.com/e2e-inc/e2e) engines
without the test runner: no config file, no report, no `expect`. An optional
agent acts on the screen from plain-language instructions. The test runner,
`e2e`, is built on it, and the engines peer on it.

```bash
npm install e2e-core @e2e-dev/web
```

```ts
import { launch } from 'e2e-core';
import { web } from '@e2e-dev/web/engine';

await using shop = await launch(web(), { app: { url: 'https://shop.example.com' } });
await using session = await shop.newSession();
await session.app.open('/products/A-1001');
const price = await session.screen.getByTestId('sale-price').textContent();
```

The same code drives an iOS or Android app with `mobile()` from
`@e2e-dev/mobile/engine`. See [the e2e-core guide](https://e2e.com/docs/core)
for sessions, saved state, secrets, and the agent with its replay cache and
guard.
