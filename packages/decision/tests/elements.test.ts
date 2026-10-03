import { describe, expect, it } from 'vitest';
import type { ExecutorActions, ExecutorNode } from 'e2e';
import { actionSpace } from '../src/elements.ts';
import { context } from './helpers.ts';

function tree(children: ExecutorNode[]): ExecutorNode {
  return { id: 'root', children };
}
function spaceFor(children: ExecutorNode[], verbs?: (keyof ExecutorActions)[]) {
  const fixture = context(verbs === undefined ? {} : { verbs });
  return actionSpace(fixture.ctx, { path: '/form', viewport: { width: 800, height: 600 }, tree: tree(children) }, true);
}
describe('element table', () => {
  it('offers tap on buttons and links with indexed keys', () => {
    const space = spaceFor([
      { id: 'a', role: 'button', name: 'Add' },
      { id: 'b', role: 'link', name: 'Home' },
    ]);
    expect(space.elements.map((element) => [element.index, element.role, element.label])).toEqual([
      ['1', 'button', 'Add'],
      ['2', 'link', 'Home'],
    ]);
    expect([...(space.targets.get('tap')?.keys() ?? [])]).toEqual(['1', '2']);
  });
  it('keeps checkbox, radio, and switch under check only', () => {
    const space = spaceFor([
      { id: 'a', role: 'checkbox', name: 'Milk', states: { checked: false } },
      { id: 'b', role: 'radio', name: 'R', states: { checked: false } },
      { id: 'c', role: 'switch', name: 'S' },
    ]);
    expect(space.targets.get('tap')).toBeUndefined();
    expect([...(space.targets.get('check')?.keys() ?? [])]).toEqual(['1', '2', '3']);
    expect(space.elements[0]).toMatchObject({ checked: false, operations: ['check'] });
  });
  it('never offers check on a checked radio, which would uncheck it', () => {
    const space = spaceFor([
      { id: 'on', role: 'radio', name: 'Express', states: { checked: true } },
      { id: 'off', role: 'radio', name: 'Standard', states: { checked: false } },
      { id: 'box', role: 'checkbox', name: 'Gift', states: { checked: true } },
    ]);
    expect(space.elements.map((element) => element.label)).toEqual(['Standard', 'Gift']);
    expect([...(space.targets.get('check')?.keys() ?? [])]).toEqual(['1', '2']);
    expect(space.pageText).toBe('Express (checked)');
  });
  it('offers a native select only under select, with per-option keys', () => {
    const space = spaceFor([{ id: 's', role: 'combobox', name: 'Size', children: [
      { id: 'o1', role: 'option', name: 'Small' },
      { id: 'o2', role: 'option', name: 'Large' },
    ] }]);
    expect(space.targets.get('tap')).toBeUndefined();
    expect(space.targets.get('type')).toBeUndefined();
    expect([...(space.targets.get('select')?.keys() ?? [])]).toEqual(['1:0', '1:1']);
    expect(space.elements[0]).toMatchObject({ operations: ['select'] });
  });
  it('skips hidden and disabled options', () => {
    const space = spaceFor([{ id: 's', role: 'combobox', name: 'Size', children: [
      { id: 'o1', role: 'option', name: 'Small' },
      { id: 'o2', role: 'option', name: 'Hidden', states: { hidden: true } },
      { id: 'o3', role: 'option', name: 'Off', states: { disabled: true } },
    ] }]);
    expect([...(space.targets.get('select')?.keys() ?? [])]).toEqual(['1:0']);
  });
  it('caps select options per question and leaves them out of omitted', () => {
    const children = Array.from({ length: 260 }, (_, index) => ({
      id: `s${index}`, role: 'combobox', name: `Size ${index}`, children: [
        { id: `a${index}`, role: 'option', name: 'Small' },
        { id: `b${index}`, role: 'option', name: 'Large' },
      ],
    }));
    const space = spaceFor(children);
    expect(space.elements).toHaveLength(255);
    expect(space.targets.get('select')?.size).toBe(255);
    // Only the 5 rows past the element cap count: scrolling can reveal a
    // row, never an option the per-question cap dropped.
    expect(space.omitted).toBe(5);
  });
  it('keeps password fields under typeSecret only', () => {
    const space = spaceFor([{ id: 'p', role: 'textbox', name: 'Password', inputPurpose: 'password' }]);
    expect(space.targets.get('type')).toBeUndefined();
    expect(space.targets.get('submit')).toBeUndefined();
    expect([...(space.targets.get('typeSecret')?.keys() ?? [])]).toEqual(['1']);
  });
  it('skips hidden and disabled nodes, and their text stays out of the page', () => {
    const space = spaceFor([
      { id: 'a', role: 'button', name: 'Gone', states: { hidden: true } },
      { id: 'b', role: 'button', name: 'Off', states: { disabled: true } },
      { id: 'c', role: 'heading', name: 'Todos' },
    ]);
    expect(space.elements).toEqual([]);
    expect(space.targets.size).toBe(0);
    expect(space.pageText).toBe('Todos');
  });
  it('uses the placeholder as the label when there is no name', () => {
    const space = spaceFor([{ id: 'q', role: 'searchbox', attributes: { placeholder: 'Search todos' } }]);
    expect(space.elements[0]).toMatchObject({ label: 'Search todos' });
    expect(space.elements[0]?.operations).toContain('type');
  });
  it('never offers verbs the target lacks', () => {
    const space = spaceFor(
      [{ id: 'a', role: 'button', name: 'Add' }, { id: 'b', role: 'textbox', name: 'Name' }],
      ['tap'],
    );
    expect(space.targets.get('type')).toBeUndefined();
    expect(space.controls.size).toBe(0);
    expect([...(space.targets.get('tap')?.keys() ?? [])]).toEqual(['1']);
  });
  it('caps the table past 255, viewport first, and counts the omitted', () => {
    // Out-of-viewport nodes come first in tree order, so only a real
    // viewport-first sort puts the ten visible rows at the head.
    const children = Array.from({ length: 300 }, (_, index) => ({
      id: `n${index}`, role: 'button', name: `Button ${index}`,
      rect: { x: 0, y: index < 290 ? 5000 : 10, width: 50, height: 20 },
    }));
    const space = spaceFor(children);
    expect(space.elements).toHaveLength(255);
    expect(space.omitted).toBe(45);
    expect(space.elements.slice(0, 10).map((element) => element.label)).toEqual(
      Array.from({ length: 10 }, (_, position) => `Button ${290 + position}`),
    );
    expect([...(space.targets.get('tap')?.keys() ?? [])]).toHaveLength(255);
  });
  it('offers scroll and back controls when the engine declares them', () => {
    const full = spaceFor([{ id: 'a', role: 'button', name: 'Add' }]);
    expect([...full.controls.keys()].toSorted()).toEqual(['back', 'scroll_down', 'scroll_up']);
    const none = spaceFor([{ id: 'a', role: 'button', name: 'Add' }], ['tap']);
    expect(none.controls.size).toBe(0);
  });
});
describe('fingerprint', () => {
  const page = (): ExecutorNode => ({ id: 'root', children: [
    { id: 'a', role: 'textbox', name: 'Name', value: '' },
    { id: 'b', role: 'button', name: 'Add' },
  ] });
  function prints(path: string, root: ExecutorNode): string {
    const fixture = context();
    return actionSpace(fixture.ctx, { path, viewport: { width: 800, height: 600 }, tree: root }, true).fingerprint;
  }
  it('is stable when only node ids change', () => {
    const first = prints('/form', page());
    const renamed = page();
    const relabeled: ExecutorNode = { id: 'root', children: (renamed.children ?? []).map((child, index) => ({ ...child, id: `z${index}` })) };
    expect(prints('/form', relabeled)).toBe(first);
  });
  it('moves on a changed value or path', () => {
    const base = prints('/form', page());
    const changed = page();
    const field = changed.children?.[0];
    const edited: ExecutorNode = { id: 'root', children: (changed.children ?? []).map((child) => child === field ? { ...child, value: 'Ada' } : child) };
    expect(prints('/form', edited)).not.toBe(base);
    expect(prints('/other', page())).not.toBe(base);
  });
});
