import { attachedTern, ternEngine, type TernProvider } from '../../src/index.ts';
const provider: TernProvider = attachedTern({ id: 'isolated', mode: 'capture', pane: '1', binary: 'tern', env: {} });
ternEngine({ provider });
// @ts-expect-error No implicit host target.
ternEngine({});
