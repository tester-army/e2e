# @e2e-dev/browserstack

Run `@e2e-dev/mobile` tests on [BrowserStack App Automate](https://www.browserstack.com/app-automate)
real Android and iOS devices. Each worker slot leases one device, with your app installed,
and releases it when the run ends.

```bash
npm install --save-dev @e2e-dev/browserstack
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { browserstack } from '@e2e-dev/browserstack';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'android',
        device: browserstack({ device: 'Google Pixel 9', osVersion: '16.0', app: 'bs://<app-id>', appiumVersion: '3.2.0' }),
      }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

Set `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` in the run environment, from
**Account & Profile → My profile → Authentication & Security**. The username is the one
shown there, not your email address. `device` and `osVersion` must match BrowserStack's
App Automate catalog exactly, and `app` is a `bs://` app id, an `https` URL, or a local path.

See the [integration guide](https://e2e.tester.army/docs/integrations/browserstack) for every
option and the limits.

## License

Apache-2.0
