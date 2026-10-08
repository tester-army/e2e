import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { ternEngine } from '@e2e-dev/tern';
import { sway } from '@e2e-dev/sway';
import { nativeOptions } from './native-options.ts';
export default {
  targets: [{ name: 'native-controls', engine: ternEngine({ provider: sway(nativeOptions()) }), app: {
    appPath: process.execPath, launchArguments: [fileURLToPath(new URL('./src/controls.mjs', import.meta.url))],
  } }],
  tests: ['tests/native-controls.e2e.ts', 'tests/native-input.e2e.ts'],
} satisfies E2EConfig;
