import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { gateway } from 'ai';

/** Read required runtime configuration without including its value in errors. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running the Driver example`);
  return value;
}

export default {
  projectId: 'dev.e2e.samsara-driver',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'ios',
      engine: mobile({
        platform: 'ios',
        device: process.env.DRIVER_IOS_DEVICE,
      }),
      app: { bundleId: 'com.samsara.driver' },
    },
    {
      name: 'android',
      engine: mobile({
        platform: 'android',
        device: process.env.DRIVER_ANDROID_DEVICE,
      }),
      app: { bundleId: 'com.samsara.driver' },
    },
  ],
  agents: {
    default: {
      model: gateway(required('E2E_MODEL')),
      maxSteps: 40,
      context:
        'Test Samsara Driver. Stop and fail on blocking request errors. Never enter credentials. Do not select a vehicle or dismiss Assignments.',
    },
  },
  timeout: 300_000,
  workers: 1,
  retries: 0,
} satisfies E2EConfig;
