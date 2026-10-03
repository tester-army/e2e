# @e2e-dev/web

The browser engine for [`e2e`](https://www.npmjs.com/package/e2e), built on
[Playwright](https://playwright.dev).

`e2e` ships no engine of its own: every target names the engine that drives
it, and this package is the one for browsers. It implements the public
`e2e/engine` contract, so a device or desktop engine plugs into the same
seam with no privilege either way.

## Install

```bash
npm install --save-dev e2e @e2e-dev/web
```

This package depends on `playwright-core` pinned to an exact version, so the
engine always runs the Playwright it was tested against. An app that depends
on Playwright itself keeps its own copy; the two share a browser cache only
when their versions match.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: 'http://localhost:3000' } }],
} satisfies E2EConfig;
```

The target declares the app; the engine only drives it. The target's `app`
takes `url` (the base URL `app.open()` opens; required on a `web()` target),
`command` (a process the runner starts before the run and stops after it,
with `readyUrl` to poll, default `url`), `environment` (`test`, `staging`,
`production`; inferred from the host), and `identity` (a stable cache and
session key when the origin is ephemeral). `web({ url })` and the other old
app options are `INVALID_CONFIG`. A target with `app.url` is a `browser`
target, so a test can `requires: ['browser']`. Browser options:
`browser` (`chromium`, `firefox`, `webkit`; default `chromium`; or a
`BrowserProvider` that leases hosted browsers, see below), `viewport`
(`{ width, height }`; default 1280x720), `testIdAttribute` (the attribute
`getByTestId` and a node's `testId` read; default `data-testid`), `userAgent`
(the `User-Agent` every attempt sends and `navigator.userAgent` reports),
`locale` and `timezoneId` (the language and time zone every attempt runs in,
such as `de-DE` and `Europe/Berlin`), and
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
engine: web({
  connect: { cdpEndpoint: async () => acquireCloudBrowserSession() },
});
```

For transport recovery, add `connect.reconnectEndpoint(signal)`. This opts
into the remote browser's persistent default context. `cdpEndpoint` then
provisions a fresh, dedicated browser for every attempt, including retries;
`reconnectEndpoint` must return that same browser after a disconnect. The
engine verifies the default context ID and active page target ID, clears stale
references, and never repeats a dispatched operation. A missing target fails
the attempt. The host owns deleting the remote browser after cleanup.

This mode does not support `headers`, `basicAuth`, `userAgent`, `locale`, `timezoneId`, context reset, or session
state capture and restore. Recording resumes after reconnect, but a segment
lost during the disconnect remains unavailable. See the
[Playwright reference](../../docs/reference/web.mdx#recovering-a-cdp-transport)
for the lifecycle and ownership contract.

### Leasing hosted browsers (`browser`)

`connect` has no lifecycle: nothing tells the host when to delete the browser
it provisioned. Pass a `BrowserProvider` as `browser` instead and the engine
asks for a browser when one is needed and gives it back when its scope ends,
on every exit path. `scope: 'worker'` (the default) leases one browser per
worker slot in `prepare` and releases them in `finish`; a worker whose browser
drops leases a replacement itself. `scope: 'attempt'` leases a fresh browser in
every `startAttempt` and releases it in `endAttempt`, reattaching through the
lease's `reconnectEndpoint` after a transport drop, with the limits of
`connect.reconnectEndpoint`. A provider implies chromium and excludes
`connect`; no vendor ships in the package. See
[Hosted browsers](../../docs/browser.mdx#hosted-browsers) for the contract
and an example against a generic session API.

```ts
engine: web({
  browser: {
    name: 'hosted-browsers',
    acquire: async (request) => ({ id: session.id, cdpEndpoint: session.cdpUrl }),
    release: async (lease) => stopSession(lease.id),
  },
});
```

## The `browser` fixture

The engine contributes `browser`: navigation, routes, cookies, dialogs, frames,
downloads, keyboard and mouse, plus `expect(browser).toHaveURL()` and
`toHaveTitle()` and `toHaveClass()`. Import `test` from this package to have it
typed; it is the same runtime `test` as `e2e`'s.

```ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('signs in', async ({ app, screen, browser }) => {
  await app.open('/login');
  await screen.getByLabel('Email').fill('user@example.test');
  await expect(browser).toHaveURL('/dashboard');
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
npx @e2e-dev/web install chromium --with-deps
```

It downloads the browsers for the Playwright version this package pins, the
ones the engine launches. Under pnpm, run the bin by name:
`pnpm exec e2e-web install chromium --with-deps`.

`--with-deps` also installs the system libraries a slim container image lacks.

## Documentation

Full documentation lives at [e2e.tester.army/docs](https://e2e.tester.army/docs).
