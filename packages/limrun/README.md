# @e2e-dev/limrun

Run `@e2e-dev/mobile` tests on Limrun iOS simulators and Android emulators.
Each worker gets a device, its build installed, and automatic cleanup.

```ts
import { mobile } from '@e2e-dev/mobile';
import { limrun } from '@e2e-dev/limrun';

const engine = mobile({ platform: 'ios', device: limrun() });
```

Set `LIMRUN_API_KEY` in the run environment. Install `@limrun/api` and the
same `agent-device` version as `@e2e-dev/mobile`, currently `0.21.22`.
Android also requires `adb` on `PATH` for the driver's tunnel.

See the [integration guide](https://e2e.tester.army/docs/integrations/limrun)
and the [app-flow example](../../examples/with-limrun) for setup and tests
that run unchanged on both platforms.
