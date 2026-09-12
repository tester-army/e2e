# @e2edev/playwright

The browser engine for [`@e2edev/e2e`](https://www.npmjs.com/package/@e2edev/e2e), built on
[Playwright](https://playwright.dev).

`e2e` ships no engine of its own: every target names the engine that drives
it, and this package is the one for browsers. It implements the public
`@e2edev/e2e/engine` contract, so a device or desktop engine plugs into the same
seam with no privilege either way.

## Install

```bash
npm install --save-dev @e2edev/e2e @e2edev/playwright playwright
```

Bring your own Playwright: `playwright` is a peer dependency (`>=1.63.0 <2`),
not something this package installs. An app that already depends on Playwright
keeps its version, one copy in `node_modules`, and one browser cache. A version
outside the range may be rejected by your package manager as an unmet peer
(npm's `ERESOLVE`), so upgrade `playwright` within the range.

```ts title="e2e.config.ts"
import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [{ name: 'web', engine: playwright({ url: 'http://localhost:3000' }) }],
} satisfies E2EConfig;
```

The engine declares the app it drives. App options: `url` (the base URL
`app.open()` opens; required once a test navigates), `command` (a process the
runner starts before the run and stops after it, with `readyUrl` to poll,
default `url`), `environment`
(`test`, `staging`, `production`; inferred from the host), and `identity` (a
stable cache and session key when the origin is ephemeral). Browser options:
`browser` (`chromium`, `firefox`, `webkit`; default `chromium`), `viewport`
(`{ width, height }`; default 1280x720), `testIdAttribute` (the attribute
`getByTestId` and a node's `testId` read; default `data-testid`), and
`connect` — attach to a remote browser over CDP instead of launching a local
one.

### Attaching to a remote browser (`connect`)

Set `connect.cdpEndpoint` to attach over the Chrome DevTools Protocol rather
than launch. The resolver is async and called at worker init, and again at the
start of any attempt that finds the session dropped, so a hosted browser whose
endpoint is provisioned per run — a cloud session URL that is not known at
config load — resolves each time it is needed. The resolver receives an
`AbortSignal` that fires when the init or attempt is cancelled or exceeds its
budget; a browser that connects after that is detached, never used. CDP attach
is chromium-only, and disposing the engine detaches the session without
killing the remote process the host owns.

```ts
engine: playwright({
  connect: { cdpEndpoint: async () => acquireCloudBrowserSession() },
});
```

## The `web` fixture

The engine contributes `web`: navigation, routes, cookies, dialogs, frames,
downloads, keyboard and mouse, plus `expect(web).toHaveURL()` and
`toHaveTitle()` and `toHaveClass()`. Import `test` from this package to have it
typed; it is the same runtime `test` as `e2e`'s.

```ts
import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('signs in', async ({ app, screen, web }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await expect(web).toHaveURL('/dashboard');
});
```

## Browsers

A missing browser is downloaded once per run, in the runner process, after the
tests are collected and before the app starts: the progress prints in the run
log, the run's clock starts only once the download is done, and no launch or
test timeout ever includes it. Workers launch the browser the runner installed.

In CI, install browsers as their own step instead, so the cost is visible and
cacheable:

```bash
npx playwright install chromium --with-deps
```

`--with-deps` also installs the system libraries a slim container image lacks.

## Documentation

Full documentation lives at [e2e.mintlify.app](https://e2e.mintlify.app).
