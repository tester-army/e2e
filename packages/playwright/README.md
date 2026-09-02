# @e2edev/playwright

The browser backend for [`e2e`](https://www.npmjs.com/package/e2e), built on
[Playwright](https://playwright.dev).

`e2e` ships no backend of its own: every target names the backend that drives
it, and this package is the one for browsers. It implements the public
`e2e/backend` contract, so a device or desktop backend plugs into the same
seam with no privilege either way.

## Install

```bash
npm install --save-dev e2e @e2edev/playwright
```

```ts title="e2e.config.ts"
import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default defineConfig({
  app: { url: 'http://localhost:3000' },
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
});
```

Options: `browser` (`chromium`, `firefox`, `webkit`; default `chromium`) and
`viewport` (`{ width, height }`; default 1280x720).

## The `web` fixture

The backend contributes `web`: navigation, routes, cookies, dialogs, frames,
downloads, keyboard and mouse, plus `expect(web).toHaveURL()` and
`toHaveTitle()`. Import `test` from this package to have it typed; it is the
same runtime `test` as `e2e`'s.

```ts
import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await expect(web).toHaveURL('/dashboard');
});
```

## Browsers

Missing browsers are downloaded when the backend boots in each worker, before
that worker's first test starts, so a first-run download never counts against
a test's timeout. It does count against `launchTimeout`, and with several
workers the others wait on the download lock, so a cold machine with many
workers should install browsers up front.

In CI, install them as their own step instead, so the cost is visible and
cacheable:

```bash
npx playwright install chromium --with-deps
```

`--with-deps` also installs the system libraries a slim container image lacks.

## Documentation

Full documentation lives at [e2e.dev](https://e2e.dev).
