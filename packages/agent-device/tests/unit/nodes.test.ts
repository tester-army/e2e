import { describe, expect, it } from 'vitest';
import { projectSnapshot, screenTitle, viewportOf, type RawNode } from '../../src/nodes.ts';
import { SETTINGS_NODES } from '../helpers/fake-client.ts';

function project(nodes: readonly RawNode[]) {
  let counter = 0;
  return projectSnapshot(nodes, {
    testIdAttribute: 'data-testid',
    mintId: () => {
      counter += 1;
      return `n${counter}`;
    },
  });
}

describe('snapshot projection', () => {
  it('rebuilds the tree from parentIndex and keeps document order in the index', () => {
    const projected = project(SETTINGS_NODES);
    expect(projected.roots).toHaveLength(1);
    const root = projected.roots[0]!;
    expect(root.name).toBe('Settings');
    expect(root.children?.map((child) => child.name)).toEqual([
      'General',
      'About',
      'Airplane Mode',
      'Search',
      'Password',
      'Hidden',
      'Scroller',
    ]);
    expect(root.children?.[0]?.children?.[0]?.name).toBe('Back');
    expect(projected.index.map((entry) => entry.id)).toEqual(SETTINGS_NODES.map((_node, i) => `n${i + 1}`));
    expect(projected.index[2]?.parent?.kind).toBe('navigation-bar');
  });

  it('falls back to depth nesting when parentIndex is absent, and to flat roots without either', () => {
    const byDepth = project([
      { ref: '@e1', depth: 0, type: 'window' },
      { ref: '@e2', depth: 1, type: 'button', label: 'A' },
      { ref: '@e3', depth: 2, type: 'static-text', label: 'inner' },
      { ref: '@e4', depth: 1, type: 'button', label: 'B' },
    ]);
    expect(byDepth.roots).toHaveLength(1);
    expect(byDepth.roots[0]?.children?.map((child) => child.name)).toEqual(['A', 'B']);
    expect(byDepth.roots[0]?.children?.[0]?.children?.[0]?.name).toBe('inner');

    const flat = project([{ ref: '@e1', type: 'button' }, { ref: '@e2', type: 'button' }]);
    expect(flat.roots).toHaveLength(2);
  });

  it('maps platform element types onto the role vocabulary and keeps unknown types verbatim', () => {
    const [, bar, back, cell, text, toggle, field, secure] = project(SETTINGS_NODES).roots[0]!.children!.flatMap(
      (child) => [child, ...(child.children ?? [])],
    ) as never[];
    void [bar, back];
    const roles = project(SETTINGS_NODES).index.map((entry) => entry.node.role);
    expect(roles).toEqual([
      'application',
      'navigation',
      'button',
      'listitem',
      'text',
      'switch',
      'textbox',
      'textbox',
      'button',
      'listitem',
    ]);
    void [cell, text, toggle, field, secure];
  });

  it('derives states, drops secure values, and exposes identifiers as the test id attribute', () => {
    const { index } = project(SETTINGS_NODES);
    const byName = (name: string) => index.find((entry) => entry.node.name === name)!.node;
    expect(byName('Airplane Mode').states).toEqual({ checked: false });
    expect(byName('About').text).toBe('About');
    expect(byName('Search').value).toBe('wifi');
    const secure = byName('Password');
    expect(secure.value).toBeUndefined();
    expect(secure.states).toEqual({ secure: true });
    expect(secure.inputPurpose).toBe('password');
    expect(byName('Hidden').states).toEqual({ disabled: true, hidden: true });
    expect(byName('About').attributes).toEqual({ 'data-testid': 'ABOUT' });
    expect(byName('About').selector).toBe('id=ABOUT');
    expect(byName('Search').selector).toBeUndefined();
    expect(byName('Back').rect).toEqual({ x: 0, y: 47, width: 390, height: 44 });
  });

  it('honours a configured test id attribute and quotes identifiers with spaces', () => {
    const projected = projectSnapshot([{ ref: '@e1', type: 'button', identifier: 'save button' }], {
      testIdAttribute: 'accessibilityIdentifier',
      mintId: () => 'n1',
    });
    expect(projected.roots[0]?.attributes).toEqual({ accessibilityIdentifier: 'save button' });
    expect(projected.roots[0]?.selector).toBe('id="save button"');
  });

  it('strips the @ prefix off refs and leaves a node without a ref unactionable', () => {
    const { index } = project([{ ref: '@e7', type: 'button' }, { ref: 'e8', type: 'button' }, { type: 'static-text', label: 'x' }]);
    expect(index.map((entry) => entry.ref)).toEqual(['e7', 'e8', '']);
  });

  it('reads the viewport off the application node, else off the rect extent', () => {
    expect(viewportOf(SETTINGS_NODES)).toEqual({ width: 390, height: 844, scale: 1 });
    expect(viewportOf([{ type: 'button', rect: { x: 10, y: 20, width: 100, height: 50 } }])).toEqual({
      width: 110,
      height: 70,
      scale: 1,
    });
    expect(viewportOf([{ type: 'button' }])).toBeUndefined();
  });

  it('normalizes XCTest PascalCase element types onto the same vocabulary', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'Settings', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'NavigationBar', identifier: 'Settings' },
      { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'StaticText', label: 'Settings' },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'CollectionView' },
      { ref: 'e5', index: 4, parentIndex: 3, depth: 2, type: 'Cell' },
      { ref: 'e6', index: 5, parentIndex: 4, depth: 3, type: 'Button', label: 'General', identifier: 'com.apple.settings.general' },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'SecureTextField', label: 'Passcode', value: '1234' },
    ]);
    expect(projected.index.map((entry) => entry.kind)).toEqual([
      'application',
      'navigation-bar',
      'static-text',
      'collection-view',
      'cell',
      'button',
      'secure-text-field',
    ]);
    expect(projected.index.map((entry) => entry.node.role)).toEqual([
      'application',
      'navigation',
      'text',
      'collection-view',
      'listitem',
      'button',
      'textbox',
    ]);
    expect(projected.index[6]?.node.states).toEqual({ secure: true });
    expect(projected.viewport).toEqual({ width: 390, height: 844, scale: 1 });
    expect(screenTitle(projected)).toBe('Settings');
  });

  it('reads the screen title from the navigation bar, its inner text, its identifier, or nothing', () => {
    expect(screenTitle(project(SETTINGS_NODES))).toBe('General');
    expect(screenTitle(project([{ ref: '@e1', type: 'navigation-bar', identifier: 'About' }]))).toBe('About');
    const innerText = project([
      { ref: '@e1', depth: 0, type: 'navigation-bar' },
      { ref: '@e2', depth: 1, type: 'button', label: 'Back' },
      { ref: '@e3', depth: 1, type: 'static-text', label: 'About' },
    ]);
    expect(screenTitle(innerText)).toBe('About');
    expect(screenTitle(project([{ ref: '@e1', type: 'button', label: 'Go' }]))).toBeUndefined();
  });
});
