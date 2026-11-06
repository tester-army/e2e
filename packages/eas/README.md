# @e2e-dev/eas

[Expo Simulators](https://expo.dev/services/simulators) for [`e2e`](https://www.npmjs.com/package/e2e):
`mobile({ device: expoSimulators() })` runs a mobile target on
Expo's hosted iOS simulators and Android emulators.

## Install

```bash
npm install --save-dev @e2e-dev/eas
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { expoSimulators } from '@e2e-dev/eas';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'ios',
        device: expoSimulators({ buildId: process.env.EAS_BUILD_ID }),
        videoTouches: false,
      }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

The sessions belong to the Expo project the app config beside
`e2e.config.ts` links (`extra.eas.projectId`, from `app.json` or as
`expo config` evaluates `app.config.ts`); `projectId` names another.
It authenticates with `EXPO_TOKEN` from the run's environment, else with the
session `eas login` stored, as eas-cli does. Each worker slot gets its own
Expo Simulators session, started when the run starts and stopped when it ends,
and the engine drives it through the agent-device daemon Expo runs beside it.
Tests start once every slot has a simulator.

- `buildId` (or `applicationArchiveUrl`) has Expo install the app; without
  it, `device.installApp()` uploads the target's `app.appPath` through the
  daemon.
- `device` picks the simulator.
- `maxIdleTimeMinutes` (default 10) is how long Expo keeps a session no
  command reached, the backstop for a run that died.
- `maxDurationMinutes` caps a session's life (40 minutes by default, 115 on
  a high-priority plan), so a run must fit in it.
- `agentDeviceVersion` is the agent-device Expo starts, by default the one
  `@e2e-dev/mobile` pins.
- `tags` are added to the run's own.

Set the engine's `videoTouches: false` for video: drawing touches into a
recording on an Expo iOS simulator outlasts the attempt's cleanup. The package
calls Expo's API with `fetch`, so there is no SDK to install.

Full documentation lives at [e2e.com/docs/integrations/eas](https://e2e.com/docs/integrations/eas).

## License

Apache-2.0
