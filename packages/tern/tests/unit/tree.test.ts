import { expect, test } from 'vitest';
import { actionSelector, flatten, semanticTree } from '../../src/tree.ts';

const bounds = [0, 0, 100, 30];
const dump = [{ path: 'root>input', nth: 'input:nth(0)', rect: bounds, visible: true }];
test('native values and secure source masking', () => {
  const root = semanticTree({ id: 1, role: 'Window', children: [
    { id: 2, role: 'TextInput', name: 'Value', bounds, states: ['focused'], value: 'actual' },
    { id: 3, role: 'TextInput', name: 'Secret', bounds, states: ['protected'], value: 'do-not-observe' },
  ] }, [], dump, { width: 200, height: 100 });
  expect(flatten([root]).find(n => n.ref.id === 'ax:2')).toMatchObject({ value: 'actual', states: { focused: true } });
  expect(JSON.stringify(root)).not.toContain('do-not-observe');
});
test('deepest current element only; ambiguity refuses', () => {
  const node = { ref: { id: 'ax:2', revision: '' }, rect: { x: 0, y: 0, width: 100, height: 30 } };
  expect(actionSelector(node, [...dump, { path: 'root', nth: 'root', rect: bounds, visible: true }])).toBe('input:nth(0)');
  expect(() => actionSelector(node, [...dump, { path: 'other', nth: 'input:nth(1)', rect: bounds, visible: true }])).toThrow();
});
test('offscreen and duplicate identities fail closed', () => {
  const root = semanticTree({ id: 1, children: [{ id: 2, role: 'Button', bounds: [-20, 0, 10, 10] }] }, [], dump, { width: 200, height: 100 });
  expect(flatten([root]).find(n => n.ref.id === 'ax:2')?.states?.hidden).toBe(true);
  expect(() => semanticTree({ id: 1, children: [{ id: 1 }] }, [], [], { width: 1, height: 1 })).toThrow();
});
