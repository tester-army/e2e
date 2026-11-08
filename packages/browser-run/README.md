# @e2e-dev/browser-run

Cloudflare Browser Run hosted Chromium for `e2e`.

```ts
import { web } from '@e2e-dev/web';
import { browserRun } from '@e2e-dev/browser-run';

web({ browser: browserRun() });
```

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with
`Browser Rendering - Edit` permission in the run's environment. Use an app
URL reachable from Cloudflare. No Worker or vendor SDK is needed to connect.

`scope` defaults to `worker`, with a fresh context per attempt. `attempt`
leases a fresh browser per attempt and retry. `keepAlive` sets the inactivity
timeout in milliseconds, 10000 to 1200000, default 60000. `lab` opts into the
experimental browser pool.
`liveView: true` logs a read-only link for each test's actual tab, valid for
starting a viewing connection for five minutes. Share links only with trusted viewers.

The provider explicitly deletes sessions during teardown. Session IDs are
journaled in the host's temporary directory, so the parent sweeps browsers
left by a crashed worker without listing unrelated account sessions. The
journal contains no API tokens or connection headers. If the whole runner
dies or creation finishes before its receipt is saved, idle expiry remains
the fallback. Remote downloads and Cloudflare-native recording attachments
are not implemented.

HTTP 429 retries honor `Retry-After`, with backoff when absent, up to three
retries within one 30-second budget. Cancellation ends the wait promptly.
Indeterminate network failures and other HTTP errors do not retry creation.

See [the integration guide](https://e2e.com/docs/integrations/browser-run).

## Live verification

Build the workspace, deploy the testbed pages to a public HTTPS URL, and set
`BROWSER_RUN_TEST_URL`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`.
Run from `apps/testbed`:

```bash
node ../../packages/e2e/dist/cli/bin.js run --config e2e.browser-run.config.ts
BROWSER_RUN_SCOPE=attempt node ../../packages/e2e/dist/cli/bin.js run --config e2e.browser-run.config.ts
```

These checks use paid browser time. The config runs existing testbed tests
plus remote isolation, authorization, screenshot, routing, dialog, and iframe
checks with two workers and video enabled.

## License

Apache-2.0
