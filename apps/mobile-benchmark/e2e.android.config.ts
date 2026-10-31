import type { E2EConfig } from 'e2e';
import { android } from '@e2e-dev/android';
import base, { android as agentDevice } from './e2e.config.ts';

/**
 * The deterministic Android suite on the experimental direct engine
 * (`@e2e-dev/android`), which drives the emulator in process over the engine
 * protocol instead of through agent-device. `BENCH_ENGINE=agent-device`
 * runs the same selection on the default engine, for comparing the two.
 * The suites that reach `device` beyond `back()` are left out: the direct
 * engine has no such controls yet.
 */
export default {
  ...base,
  tests: ['tests/smoke.e2e.ts', 'tests/login-form.e2e.ts', 'tests/flows.e2e.ts', 'tests/flows-lists.e2e.ts', 'tests/controls.e2e.ts'],
  targets: [
    {
      name: 'android-emulator',
      engine: process.env.BENCH_ENGINE === 'agent-device' ? agentDevice : android(),
      app: { bundleId: 'dev.e2e.benchmark', appPath: process.env.E2E_MOBILE_BENCHMARK_ANDROID_APP, identity: 'dev.e2e.benchmark-android' },
    },
  ],
  workers: 1,
  reporters: ['list'],
} satisfies E2EConfig;
