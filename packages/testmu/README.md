# @e2e-dev/testmu

Run `@e2e-dev/mobile` tests on [TestMu AI](https://www.lambdatest.com) (formerly LambdaTest)
Android emulators, iOS simulators, and real devices. Each worker slot leases one device,
with your app installed, and releases it when the run ends. `@e2e-dev/web` tests run on
its hosted Chrome and Edge; see [Browsers](#browsers).

```bash
npm install --save-dev e2e @e2e-dev/mobile @e2e-dev/testmu
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { testmu } from '@e2e-dev/testmu';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'android',
        device: testmu({ device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'https://example.com/app.apk' }),
      }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

Set `LT_USERNAME` and `LT_ACCESS_KEY` in the run environment, from
**Account Settings → Password & Security → Username and Access Key**
([accounts.lambdatest.com/security/username-accesskey](https://accounts.lambdatest.com/security/username-accesskey)).
`device` and `osVersion` must match TestMu AI's catalog exactly, and `app` is an
`lt://` app id, an `https` URL, or a local path. `deviceType: 'real'` picks a real device.

See the [integration guide](https://e2e.tester.army/docs/integrations/testmu) for every
option and the limits.

## Browsers

`web({ browser: testmuBrowsers() })` runs a web target in TestMu AI's hosted Chrome or
Edge, one session per worker slot. It is exported from `@e2e-dev/testmu/web`, which needs
only `@e2e-dev/web`; the package root exports the device provider.

```bash
npm install --save-dev e2e @e2e-dev/web @e2e-dev/testmu
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { testmuBrowsers } from '@e2e-dev/testmu/web';

export default {
  targets: [{ engine: web({ browser: testmuBrowsers(), viewport: null }), app: { url: 'https://staging.example.com' } }],
  workers: 4,
} satisfies E2EConfig;
```

It reads the same `LT_USERNAME` and `LT_ACCESS_KEY`. `browserName` is `Chrome` (default)
or `MicrosoftEdge`, and `capabilities` takes `browserVersion` and `LT:Options` fields such
as `platform`, `geoLocation`, and `video`. See the
[integration guide](https://e2e.tester.army/docs/integrations/testmu) for the
defaults and the limits.

## License

Apache-2.0
