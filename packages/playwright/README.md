# @e2edev/playwright

The default browser driver for [`e2e`](https://www.npmjs.com/package/e2e), built
on [Playwright](https://playwright.dev).

It ships as its own package so a project that automates something other than a
browser does not pay for a browser download. `e2e` loads it on demand.

## Install

```bash
npm install --save-dev e2e @e2edev/playwright
```

That is all the setup there is. Web targets use this driver by default:

```ts title="e2e.config.ts"
import { defineConfig } from 'e2e';

export default defineConfig({
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
});
```

Supported browsers are `chromium`, `firefox`, and `webkit`.

## Browsers

Missing browsers are downloaded once, before the first test starts, so a
first-run download never counts against a test's timeout.

In CI, install them as their own step instead, so the cost is visible and
cacheable:

```bash
npx playwright install chromium --with-deps
```

`--with-deps` also installs the system libraries a slim container image lacks.

## Passing the driver explicitly

Only needed if you want to construct the driver yourself:

```ts
import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  targets: [{ name: 'web', platform: 'web', driver: playwright() }],
});
```

## Documentation

Full documentation lives at [e2e.dev](https://e2e.dev).
