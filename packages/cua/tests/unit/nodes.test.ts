import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '@e2edev/e2e/engine';
import { normalizeKind, projectSnapshot, quoteTerm } from '../../src/nodes.ts';
import { WINDOW_STATE } from '../helpers/fake-client.ts';

function project(state = WINDOW_STATE) {
  let counter = 0;
  return projectSnapshot(state, { testIdAttribute: 'data-testid', mintId: () => `n${(counter += 1)}` });
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

function named(nodes: readonly SemanticNode[], name: string): SemanticNode {
  const found = [...walk(nodes)].find((node) => node.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

describe('normalizeKind', () => {
  it('folds AX roles, UIA control types, and AT-SPI roles into one spelling', () => {
    expect(normalizeKind('AXPopUpButton')).toBe('pop-up-button');
    expect(normalizeKind('AXStaticText')).toBe('static-text');
    expect(normalizeKind('CheckBox')).toBe('check-box');
    expect(normalizeKind('push button')).toBe('push-button');
    expect(normalizeKind('page_tab_list')).toBe('page-tab-list');
  });
});

describe('projectSnapshot', () => {
  it('rebuilds the tree from parent indices and maps platform roles onto the vocabulary', () => {
    const { roots, index } = project();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.role).toBe('window');
    expect(index).toHaveLength(11);
    expect(named(roots, 'Bold').role).toBe('button');
    expect(named(roots, 'Font').role).toBe('combobox');
    expect(named(roots, 'Document').role).toBe('textbox');
    expect(named(roots, 'Ready').role).toBe('text');
    expect(named(roots, 'Plain').role).toBe('radio');
    expect(named(roots, 'Toolbar').children?.map((child) => child.name)).toEqual(['Bold', 'Font']);
  });

  it('derives states: checked from value, disabled, focused, hidden from an empty frame, secure from the role', () => {
    const { roots } = project();
    expect(named(roots, 'Wrap').states).toEqual({ checked: true });
    expect(named(roots, 'Plain').states).toEqual({ checked: false });
    expect(named(roots, 'Hidden').states).toEqual({ disabled: true, hidden: true });
    expect(named(roots, 'Document').states).toEqual({ focused: true });
    const secure = named(roots, 'Password');
    expect(secure.states).toEqual({ secure: true });
    expect(secure.inputPurpose).toBe('password');
    expect(secure.value).toBeUndefined();
  });

  it('keeps values that are content and drops echoes and checkbox states', () => {
    const { roots } = project();
    expect(named(roots, 'Document').value).toBe('Hello');
    expect(named(roots, 'Font').value).toBe('Helvetica');
    expect(named(roots, 'Wrap').value).toBeUndefined();
    expect(named(roots, 'Search').value).toBeUndefined();
    expect(named(roots, 'Ready').text).toBe('Ready');
  });

  it('rebases screenshot pixels onto window points and reports the viewport and scale', () => {
    const { roots, viewport, pixelScale, windowOrigin, index } = project();
    expect(viewport).toEqual({ width: 600, height: 400, scale: 1 });
    expect(pixelScale).toBe(2);
    expect(windowOrigin).toEqual({ x: 100, y: 50 });
    expect(named(roots, 'Bold').rect).toEqual({ x: 10, y: 5, width: 30, height: 20 });
    expect(index.find((entry) => entry.node.name === 'Bold')?.pixelCentre).toEqual({ x: 50, y: 30 });
  });

  it('exposes the identifier as the test id attribute and as a structural selector', () => {
    const { roots } = project();
    const bold = named(roots, 'Bold');
    expect(bold.attributes).toEqual({ 'data-testid': 'bold' });
    expect(bold.selector).toBe('id=bold');
    expect(named(roots, 'Font').selector).toBeUndefined();
  });

  it('reads Windows and AT-SPI field names', () => {
    const state = {
      elements: [
        { element_index: 0, element_token: 'w:0', control_type: 'Window', name: 'Main', depth: 0, rect: { x: 0, y: 0, width: 800, height: 600 } },
        { element_index: 1, element_token: 'w:1', control_type: 'Edit', name: 'Email', automation_id: 'EmailBox', parent_index: 0, depth: 1, rect: { x: 10, y: 10, width: 200, height: 30 } },
        { element_index: 2, element_token: 'a:2', role: 'push button', name: 'OK', parent_index: 0, depth: 1, enabled: true },
        { element_index: 3, element_token: 'a:3', role: 'check box', name: 'Agree', checked: true, parent_index: 0, depth: 1 },
      ],
    };
    const { roots, viewport } = project(state);
    expect(viewport).toBeUndefined();
    expect(named(roots, 'Email')).toMatchObject({ role: 'textbox', attributes: { 'data-testid': 'EmailBox' }, selector: 'id=EmailBox' });
    expect(named(roots, 'OK').role).toBe('button');
    expect(named(roots, 'Agree')).toMatchObject({ role: 'checkbox', states: { checked: true } });
  });

  it('quotes selector terms that need it', () => {
    expect(quoteTerm('bold')).toBe('bold');
    expect(quoteTerm('Save As')).toBe('"Save As"');
    expect(quoteTerm('a=b')).toBe('"a=b"');
  });
});
