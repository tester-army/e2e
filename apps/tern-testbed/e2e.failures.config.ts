import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { ternEngine } from '@e2e-dev/tern';
import { sway } from '@e2e-dev/sway';
import { nativeOptions } from './native-options.ts';
const root=process.env.E2E_NATIVE_FAILURE_ROOT;
if(!root)throw new Error('Negative native fixtures require their own explicit root');
export default {
  targets:[{name:'native-failures',engine:ternEngine({provider:sway({...nativeOptions(),root})}),app:{appPath:process.execPath,launchArguments:[fileURLToPath(new URL('./src/controls.mjs',import.meta.url))]}}],
  tests:['tests/failures/lifecycle.e2e.ts'],
} satisfies E2EConfig;
