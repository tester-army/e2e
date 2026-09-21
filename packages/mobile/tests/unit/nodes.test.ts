import { describe, expect, it } from 'vitest';
import { projectSnapshot, screenTitle, viewportOf, type RawNode } from '../../src/nodes.ts';
import { SETTINGS_NODES } from '../helpers/fake-client.ts';

function project(nodes: readonly RawNode[]) {
  let counter = 0;
  return projectSnapshot(nodes, {
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
    expect(byName('About').testId).toBe('ABOUT');
    expect(byName('About').attributes).toBeUndefined();
    expect(byName('About').selector).toBe('id=ABOUT');
    expect(byName('Search').selector).toBeUndefined();
    expect(byName('Back').rect).toEqual({ x: 0, y: 47, width: 390, height: 44 });
  });

  it('reports the accessibility identifier as the test id and quotes identifiers with spaces in the selector', () => {
    const projected = projectSnapshot([{ ref: '@e1', type: 'button', identifier: 'save button' }], { mintId: () => 'n1' });
    expect(projected.roots[0]?.testId).toBe('save button');
    expect(projected.roots[0]?.selector).toBe('id="save button"');
  });

  it('strips the @ prefix off refs and leaves a node without a ref unactionable', () => {
    const { index } = project([{ ref: '@e7', type: 'button' }, { ref: 'e8', type: 'button' }, { type: 'static-text', label: 'x' }]);
    expect(index.map((entry) => entry.ref)).toEqual(['e7', 'e8', '']);
  });

  it('reads the viewport off the application node, else off the rect extent', () => {
    expect(viewportOf(SETTINGS_NODES)).toEqual({ width: 390, height: 844 });
    expect(viewportOf([{ type: 'button', rect: { x: 10, y: 20, width: 100, height: 50 } }])).toEqual({
      width: 110,
      height: 70,
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
    expect(projected.viewport).toEqual({ width: 390, height: 844 });
    expect(screenTitle(projected)).toBe('Settings');
  });

  it('maps iOS composite widgets onto the vocabulary roles a browser reports for them', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'Shop' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'TabBar' },
      { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'Button', label: 'Cart', selected: true },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'SegmentedControl' },
      { ref: 'e5', index: 4, parentIndex: 3, depth: 2, type: 'Button', label: 'Weekly' },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'ProgressIndicator', label: 'Upload', value: '40%' },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'ActivityIndicator', label: 'Loading' },
      { ref: 'e8', index: 7, parentIndex: 0, depth: 1, type: 'Stepper', label: 'Quantity', value: '2' },
      { ref: 'e9', index: 8, parentIndex: 0, depth: 1, type: 'Toolbar' },
      { ref: 'e10', index: 9, parentIndex: 0, depth: 1, type: 'Menu' },
      { ref: 'e11', index: 10, parentIndex: 9, depth: 2, type: 'MenuItem', label: 'Copy' },
      { ref: 'e12', index: 11, parentIndex: 0, depth: 1, type: 'RadioGroup' },
      { ref: 'e13', index: 12, parentIndex: 11, depth: 2, type: 'RadioButton', label: 'Card' },
      { ref: 'e14', index: 13, parentIndex: 0, depth: 1, type: 'Table' },
      { ref: 'e15', index: 14, parentIndex: 13, depth: 2, type: 'TableRow' },
      { ref: 'e16', index: 15, parentIndex: 0, depth: 1, type: 'Group' },
      { ref: 'e17', index: 16, parentIndex: 0, depth: 1, type: 'Other' },
      { ref: 'e18', index: 17, parentIndex: 0, depth: 1, type: 'PickerWheel' },
    ]);
    expect(projected.index.map((entry) => entry.node.role)).toEqual([
      'application',
      'tablist',
      'tab',
      'tablist',
      'tab',
      'progressbar',
      'status',
      'spinbutton',
      'toolbar',
      'menu',
      'menuitem',
      'radiogroup',
      'radio',
      'table',
      'row',
      'group',
      'other',
      'picker-wheel',
    ]);
    expect(projected.index[5]?.node.value).toBe('40%');
    expect(projected.index[2]?.node.states).toEqual({ selected: true });
    // Only a tab container's buttons are tabs; the toolbar's stay buttons.
    const toolbar = project([
      { ref: 'e1', index: 0, depth: 0, type: 'Toolbar' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'Button', label: 'Share' },
    ]);
    expect(toolbar.index.map((entry) => entry.node.role)).toEqual(['toolbar', 'button']);
  });

  it('maps Android composite widgets, including the nested tab and bottom navigation item classes', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'com.google.android.material.tabs.TabLayout' },
      { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'com.google.android.material.tabs.TabLayout$TabView', label: 'Open' },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'com.google.android.material.bottomnavigation.BottomNavigationView' },
      { ref: 'e5', index: 4, parentIndex: 3, depth: 2, type: 'com.google.android.material.bottomnavigation.BottomNavigationItemView', label: 'Home' },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'android.widget.ProgressBar', label: 'Upload' },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.RadioGroup' },
      { ref: 'e8', index: 7, parentIndex: 6, depth: 2, type: 'android.widget.RadioButton', label: 'Card' },
      { ref: 'e9', index: 8, parentIndex: 0, depth: 1, type: 'androidx.appcompat.widget.Toolbar' },
      { ref: 'e10', index: 9, parentIndex: 0, depth: 1, type: 'android.widget.NumberPicker' },
      { ref: 'e11', index: 10, parentIndex: 0, depth: 1, type: 'android.widget.TabWidget' },
    ]);
    expect(projected.index.map((entry) => entry.kind)).toEqual([
      'frame-layout',
      'tab-layout',
      'tab-layout$tab-view',
      'bottom-navigation-view',
      'bottom-navigation-item-view',
      'progress-bar',
      'radio-group',
      'radio-button',
      'toolbar',
      'number-picker',
      'tab-widget',
    ]);
    expect(projected.index.map((entry) => entry.node.role)).toEqual([
      'group',
      'tablist',
      'tab',
      'tablist',
      'tab',
      'progressbar',
      'radiogroup',
      'radio',
      'toolbar',
      'spinbutton',
      'tablist',
    ]);
  });

  it('maps Android view classes, drops echoed values, and titles the screen from the toolbar', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'android.widget.FrameLayout', label: 'Network & internet', identifier: 'com.android.settings:id/collapsing_toolbar' },
      { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'androidx.recyclerview.widget.RecyclerView', identifier: 'com.android.settings:id/recycler_view' },
      { ref: 'e4', index: 3, parentIndex: 2, depth: 2, type: 'android.widget.LinearLayout' },
      { ref: 'e5', index: 4, parentIndex: 3, depth: 3, type: 'android.widget.TextView', label: 'Airplane mode', value: 'Airplane mode', identifier: 'android:id/title' },
      { ref: 'e6', index: 5, parentIndex: 3, depth: 3, type: 'android.widget.Switch' },
      { ref: 'e7', index: 6, parentIndex: 2, depth: 2, type: 'android.widget.EditText', label: 'Search', value: 'wifi' },
      { ref: 'e8', index: 7, parentIndex: 2, depth: 2, type: 'android.widget.ImageButton', label: 'Back' },
    ]);
    expect(projected.index.map((entry) => entry.kind)).toEqual([
      'frame-layout',
      'frame-layout',
      'recycler-view',
      'linear-layout',
      'text-view',
      'switch',
      'edit-text',
      'image-button',
    ]);
    expect(projected.index.map((entry) => entry.node.role)).toEqual([
      'group',
      'group',
      'list',
      'group',
      'text',
      'switch',
      'textbox',
      'button',
    ]);
    const title = projected.index[4]!.node;
    expect(title.name).toBe('Airplane mode');
    expect(title.value).toBeUndefined();
    expect(projected.index[6]!.node.value).toBe('wifi');
    expect(title.testId).toBe('android:id/title');
    expect(screenTitle(projected)).toBe('Network & internet');
    expect(screenTitle(project([{ ref: 'e1', type: 'android.widget.FrameLayout', label: 'x' }]))).toBeUndefined();
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
