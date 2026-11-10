# @e2e-dev/e2b

Run Android and web tests in [E2B](https://e2b.dev) sandboxes. Each worker gets its own
Android 16 sandbox with your `.apk` installed, and the sandbox is deleted when the run ends.
No Android SDK or `adb` is needed on your machine. For web tests, see [Browsers](#browsers).

```bash
npm install --save-dev e2e @e2e-dev/mobile @e2e-dev/e2b e2b
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { e2b } from '@e2e-dev/e2b';

export default {
  targets: [
    {
      engine: mobile({ platform: 'android', device: e2b() }),
      app: { bundleId: 'com.example.app', appPath: 'build/app-debug.apk' },
    },
  ],
  workers: 4,
} satisfies E2EConfig;
```

Set `E2B_API_KEY` from the [E2B dashboard](https://e2b.dev/dashboard), and `E2B_DOMAIN`
for a dedicated E2B cluster. Android on E2B is x86_64 only, without Google Play Services.
Sandboxes refuse public traffic; tests reach them through a local tunnel on `127.0.0.1`.

See the [integration guide](https://e2e.tester.army/docs/integrations/e2b) for every
option and the limits.

## Browsers

`web({ browser: e2bBrowsers() })` runs a web target in Chromium in an E2B sandbox: one
sandbox per worker, or per attempt with `scope: 'attempt'`. Import it from
`@e2e-dev/e2b/web`, which needs only `@e2e-dev/web`.

```bash
npm install --save-dev e2e @e2e-dev/web @e2e-dev/e2b e2b
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { e2bBrowsers } from '@e2e-dev/e2b/web';

export default {
  targets: [{ engine: web({ browser: e2bBrowsers() }), app: { url: 'https://staging.example.com' } }],
  workers: 4,
} satisfies E2EConfig;
```

It uses the same `E2B_API_KEY`, and a sandbox template with Chromium that you build once
from the Playwright image. The browser runs in E2B's cloud, so `app.url` must be reachable
from the internet. See the
[integration guide](https://e2e.tester.army/docs/integrations/e2b) for the template, the
defaults, and the limits.

## License

Apache-2.0
