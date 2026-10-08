# @e2e-dev/testmu

[TestMu AI](https://www.lambdatest.com) (formerly LambdaTest) for [`e2e`](https://www.npmjs.com/package/e2e):
`mobile({ device: testmu({ device, osVersion, app }) })` runs a mobile target on
TestMu AI's hosted Android emulators, iOS simulators, and real devices.

## Install

```bash
npm install --save-dev @e2e-dev/testmu agent-device@<version>
```

The provider drives TestMu AI through agent-device's `testmu` cloud
provider, so the project needs an agent-device that includes it, and
`@e2e-dev/mobile` must use that same agent-device: override its pin (npm and
bun `overrides`, pnpm `overrides` in `pnpm-workspace.yaml`). No published
agent-device release includes the `testmu` provider yet; `<version>` is the
first one that does. The peer range only excludes the releases known to lack
it.

## Usage

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

It authenticates with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's
environment. While it calls the agent-device daemon it starts for the run,
it sets both in the runner's `process.env`, where that daemon reads them,
and puts back the previous values afterwards. Each worker slot leases one
device from that daemon. Allocating the lease starts the TestMu AI
session, which installs `app`, so every slot is billed from the moment it is
leased, even when no test runs on it. The lease is released when the run
ends, which ends the session.

- `device` and `osVersion` must match TestMu AI's catalog exactly: `18.0`
  for a virtual iOS device, `18` for a real one, `14` on Android.
- `app` is required: an `lt://` app id, an `https` URL, or a local path
  resolved against the project root, which TestMu AI installs when the
  session starts. Keep the target's `app.bundleId`. The provider refuses
  `app.appPath` on purpose, since it hands TestMu AI the build itself;
  `device.installApp()` with a path still works during a test.
- `deviceType: 'real'` picks a real device (default `'virtual'`).
- `project` (default `e2e`), `build` (default the run id), and `sessionName`
  (default `e2e-<run id>-<target>-<slot>`) label the sessions on the
  dashboard. A given `sessionName` gets `-<slot>` appended when the target
  has more than one worker slot, so each slot's session has its own name.
- `orientation` (`'portrait'` or `'landscape'`), `geoLocation`, `timezone`,
  `language`, `locale`, and `appiumVersion` set up the device when the
  session starts.
- `stateDir` (default `.e2e/testmu`) holds each run's daemon, in a
  directory per run that is kept after the run for its logs. A run removes
  directories earlier runs marked as the provider's once nothing in them
  has changed for 24 hours; it never removes a directory it did not mark.

Sessions run over TestMu AI's Appium hub, so agent-device's device settings,
system alerts, recording, device logs, and port reverse are not available
there. An attempt that records video links TestMu AI's recording of the
whole session instead, found by the session's build and name and starting
at the session's start time. Runs that overlap and share a fixed `build`
and `sessionName` can link each other's videos; the defaults never do.

## Browsers

`web({ browser: testmuBrowsers() })` runs a web target in TestMu AI's hosted
Chrome or Edge on Windows and macOS, one session per worker slot, or one per
attempt with `scope: 'attempt'`. It is exported from `@e2e-dev/testmu/web`,
which needs only `@e2e-dev/web`; the package root exports the device
provider.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { testmuBrowsers } from '@e2e-dev/testmu/web';

export default {
  targets: [
    {
      name: 'testmu-web',
      engine: web({ browser: testmuBrowsers({ platform: 'Windows 11' }), viewport: null }),
      app: { url: 'https://staging.example.com' },
    },
  ],
} satisfies E2EConfig;
```

A session starts when its CDP websocket opens and ends when the engine
closes it, so the provider only builds the CDP URL from the options and
`LT_USERNAME`/`LT_ACCESS_KEY`, and calls no API.

## Credentials

Both providers read `LT_USERNAME` and `LT_ACCESS_KEY` from the run's
environment. To get them, [sign up for TestMu AI](https://accounts.lambdatest.com/register)
or log in to your account, then copy your username and access key from
**Account Settings → Password & Security → Username and Access Key**
([accounts.lambdatest.com/security/username-accesskey](https://accounts.lambdatest.com/security/username-accesskey)).

Full documentation lives at [e2e.tester.army/docs/integrations/testmu](https://e2e.tester.army/docs/integrations/testmu)
(devices) and [e2e.tester.army/docs/integrations/testmu-browsers](https://e2e.tester.army/docs/integrations/testmu-browsers)
(browsers).

## License

Apache-2.0
