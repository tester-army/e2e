import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { ternEngine } from '@e2e-dev/tern';
import { hyprland, type HyprlandOptions } from '@e2e-dev/hyprland';
const path=process.env.E2E_HYPRLAND_FIXTURE_OPTIONS;
if(!path)throw new Error('Supply the explicitly owned disposable fixture options; never discover the operator instance');
const options=JSON.parse(readFileSync(path,'utf8')) as HyprlandOptions;
export default {
  targets:[{name:'native-controls',engine:ternEngine({provider:hyprland(options)}),app:{appPath:process.execPath,launchArguments:[fileURLToPath(new URL('./src/controls.mjs',import.meta.url))]}}],
  tests:['tests/native-controls.e2e.ts','tests/native-input.e2e.ts'],
} satisfies E2EConfig;
