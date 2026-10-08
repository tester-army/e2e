import { expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { semanticTree } from '../../src/tree.ts';
const dump = [{ path: '/input', nth: 'nth:1', rect: [1, 1, 100, 30], visible: true }];
it('does not choose an acknowledged draft over disagreeing native accessibility value', () => {
  expect(() => semanticTree({ id: 1, role: 'TextInput', value: '0', bounds: [1, 1, 100, 30] },
    [{ rect: [1, 1, 100, 30], input: { value: '7' } }], dump, { width: 200, height: 100 })).toThrow(EngineError);
});
it('withholds values identified as passwords by native role or actual control type', () => {
  const tree = semanticTree({ id: 1, role: 'PasswordInput', value: 'inert-secret-sentinel', bounds: [1, 1, 100, 30] },
    [{ rect: [1, 1, 100, 30], input: { value: 'inert-secret-sentinel', type: 'password' } }], dump, { width: 200, height: 100 });
  expect(tree.children?.[0]?.value).toBeUndefined();
  expect(tree.children?.[0]?.states?.secure).toBe(true);
});
