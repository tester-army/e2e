# @e2e-dev/limrun

Run `@e2e-dev/mobile` tests on Limrun iOS simulators and Android emulators.
Each worker gets a device, its build installed, and automatic cleanup.

```ts
import { mobile } from '@e2e-dev/mobile';
import { limrun } from '@e2e-dev/limrun';

const engine = mobile({ platform: 'ios', device: limrun() });
```

Set `LIMRUN_API_KEY` in the run environment and install `@limrun/api`.
Android also requires `adb` on `PATH` for the driver's tunnel.

See the [integration guide](https://e2e.com/docs/integrations/limrun) for setup.
Find partner examples in [Community packages](https://e2e.com/docs/community-packages#find-related-integrations).
