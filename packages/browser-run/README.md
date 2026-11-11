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
timeout in milliseconds, 10000 to 1200000, default 60000.

Sessions are deleted during teardown. If the runner exits before cleanup,
the inactivity timeout ends the browser. Remote downloads and Cloudflare-native
recording attachments are not implemented.

See [the integration guide](https://e2e.com/docs/integrations/browser-run).

## License

Apache-2.0
