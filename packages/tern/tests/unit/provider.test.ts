import { expect, test } from 'vitest';
import { attachedTern } from '../../src/provider.ts';

test('borrowed identity is explicit and survives release', async () => {
  const lease = { id: 'test', mode: 'native' as const, pane: '1', control: '/private/control.sock', binary: '/bin/tern', env: {} };
  const provider = attachedTern(lease);
  expect(provider.borrowed).toBe(true);
  await provider.release(lease, { signal: new AbortController().signal, timeoutMs: 1000 });
  expect(await provider.acquire({} as never)).toBe(lease);
});
test('no implicit socket discovery', () => {
  expect(() => attachedTern({ id: 'test', mode: 'native', pane: '1', binary: '/bin/tern', env: {} })).toThrow();
});
