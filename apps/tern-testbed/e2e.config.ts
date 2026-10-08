import type { E2EConfig } from 'e2e';
import { attachedTern, ternEngine } from '@e2e-dev/tern';

const control = process.env.E2E_TERN_CONTROL;
const pane = process.env.E2E_TERN_PANE;
const binary = process.env.E2E_TERN_BINARY;
if (!control || !pane || !binary) throw new Error('Supply an explicitly owned isolated native Tern fixture; no default host endpoint exists');

export default {
  tests: 'tests/native-controls.e2e.ts',
  targets: [{ name: 'native', engine: ternEngine({ provider: attachedTern({ id: 'inert-controls', pane, control, binary, mode: 'native', env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' } }) }) }],
} satisfies E2EConfig;
