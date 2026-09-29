# @e2e-dev/eas

[EAS Simulators](https://expo.dev/services/simulators) for [`e2e`](https://www.npmjs.com/package/e2e):
`mobile({ device: easSimulators({ projectId }) })` runs a mobile target on
Expo's hosted iOS simulators and Android emulators.

## Install

```bash
npm install --save-dev @e2e-dev/eas
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { easSimulators } from '@e2e-dev/eas';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'ios',
        app: 'com.example.app',
        device: easSimulators({ projectId: '<expo project id>', buildId: process.env.EAS_BUILD_ID }),
        videoTouches: false,
      }),
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

`EXPO_TOKEN` comes from the run's environment. Each worker slot gets its own
EAS Simulators session, started when the run starts and stopped when it ends,
and the engine drives it through the agent-device daemon EAS runs beside it.
Tests start once every slot has a simulator.

- `buildId` (or `applicationArchiveUrl`) has EAS install the app; without
  it, `device.installApp()` uploads a local build through the daemon.
- `device` picks the simulator.
- `maxIdleTimeMinutes` (default 10) is how long EAS keeps a session no
  command reached, the backstop for a run that died.
- `maxDurationMinutes` caps a session's life (40 minutes by default, 115 on
  a high-priority plan), so a run must fit in it.
- `agentDeviceVersion` is the agent-device EAS starts, by default the one
  `@e2e-dev/mobile` pins.
- `tags` are added to the run's own.

Set the engine's `videoTouches: false` for video: drawing touches into a
recording on an EAS iOS simulator outlasts the attempt's cleanup. The package
calls Expo's API with `fetch`, so there is no SDK to install.

Full documentation lives at [e2e.tester.army/docs/integrations/eas](https://e2e.tester.army/docs/integrations/eas).

## License

Apache-2.0
