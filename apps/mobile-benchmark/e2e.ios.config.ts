import type { E2EConfig } from 'e2e';
import { ios } from '@e2e-dev/ios';
import base, { ios as agentDevice } from './e2e.config.ts';

/**
 * The deterministic iOS suite on the experimental Swift engine
 * (`@e2e-dev/ios`), an XCUITest-hosted engine protocol server, instead of
 * agent-device. `BENCH_ENGINE=agent-device` runs the same selection on the
 * default engine. One simulator: `E2E_IOS_UDID`, else the one booted. The
 * suites that reach `device` beyond `back()` are left out: the Swift engine
 * has no such controls yet.
 */
export default {
  ...base,
  tests: ['tests/smoke.e2e.ts', 'tests/login-form.e2e.ts', 'tests/flows.e2e.ts', 'tests/flows-lists.e2e.ts', 'tests/controls.e2e.ts'],
  targets: [
    {
      name: 'ios-simulator',
      engine: process.env.BENCH_ENGINE === 'agent-device' ? agentDevice : ios(),
      app: { bundleId: 'dev.e2e.benchmark', appPath: process.env.E2E_MOBILE_BENCHMARK_IOS_APP, identity: 'dev.e2e.benchmark-ios' },
    },
  ],
  workers: 1,
  reporters: ['list'],
} satisfies E2EConfig;
