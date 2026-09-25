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

  it('leaves the Android status bar and navigation bar out, with their children, and keeps the app window', () => {
    const systemui = 'com.android.systemui';
    const projected = project([
      { ref: '@e1', depth: 0, type: 'androidx.compose.ui.platform.ComposeView', bundleId: systemui, rect: { x: 0, y: 0, width: 1080, height: 63 } },
      { ref: '@e2', depth: 1, type: 'android.widget.TextView', bundleId: systemui, label: '10:17', identifier: 'com.android.systemui:id/clock', rect: { x: 11, y: 2, width: 136, height: 58 } },
      { ref: '@e3', depth: 1, type: 'android.widget.FrameLayout', bundleId: systemui, label: 'T-Mobile, three bars.', identifier: 'com.android.systemui:id/mobile_combo', rect: { x: 797, y: 2, width: 61, height: 58 } },
      { ref: '@e4', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ref: '@e5', depth: 1, type: 'android.widget.TextView', bundleId: 'dev.e2e.benchmark', label: 'Hello', rect: { x: 0, y: 200, width: 1080, height: 60 } },
      { ref: '@e6', depth: 0, type: 'android.widget.FrameLayout', bundleId: systemui, rect: { x: 0, y: 2274, width: 1080, height: 126 } },
      { ref: '@e7', depth: 1, type: 'android.widget.ImageView', bundleId: systemui, label: 'Back', rect: { x: 100, y: 2290, width: 100, height: 100 } },
    ]);
    expect(projected.roots.map((root) => root.children?.map((child) => child.name))).toEqual([['Hello']]);
    expect(projected.index.map((entry) => entry.node.name)).toEqual([undefined, 'Hello']);
    expect(projected.viewport).toEqual({ width: 1080, height: 2400 });
  });

  it('keeps a systemui window that covers the screen, and every window on a platform that reports no package', () => {
    const shade = project([
      { ref: '@e1', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ref: '@e2', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'com.android.systemui', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ref: '@e3', depth: 1, type: 'android.widget.TextView', bundleId: 'com.android.systemui', label: 'No notifications', rect: { x: 0, y: 1000, width: 1080, height: 60 } },
    ]);
    expect(shade.roots).toHaveLength(2);
    expect(shade.index.map((entry) => entry.node.name)).toContain('No notifications');

    const ios = project([
      { ref: '@e1', depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: '@e2', depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 47 } },
      { ref: '@e3', depth: 1, type: 'StaticText', label: '9:41', rect: { x: 20, y: 10, width: 60, height: 20 } },
    ]);
    expect(ios.roots).toHaveLength(2);
  });

  it('keeps a compact systemui popup at an edge, controls included, while the full-width bar beside it goes', () => {
    const systemui = 'com.android.systemui';
    const projected = project([
      { ref: '@e1', depth: 0, type: 'androidx.compose.ui.platform.ComposeView', bundleId: systemui, rect: { x: 0, y: 0, width: 1080, height: 63 } },
      { ref: '@e2', depth: 1, type: 'android.widget.TextView', bundleId: systemui, label: '10:17', rect: { x: 11, y: 2, width: 136, height: 58 } },
      { ref: '@e3', depth: 0, type: 'android.widget.FrameLayout', bundleId: systemui, rect: { x: 80, y: 0, width: 920, height: 180 } },
      { ref: '@e4', depth: 1, type: 'android.widget.Button', bundleId: systemui, label: 'Reply', rect: { x: 700, y: 100, width: 200, height: 60 } },
      { ref: '@e5', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ref: '@e6', depth: 1, type: 'android.widget.TextView', bundleId: 'dev.e2e.benchmark', label: 'Hello', rect: { x: 0, y: 200, width: 1080, height: 60 } },
    ]);
    expect(projected.roots).toHaveLength(2);
    expect(projected.index.map((entry) => entry.node.name)).toContain('Reply');
    expect(projected.index.map((entry) => entry.node.name)).not.toContain('10:17');
  });

  it('reads the screen off the largest window, so a bar that is a window itself still goes', () => {
    const systemui = 'com.android.systemui';
    const projected = project([
      { ref: '@e1', depth: 0, type: 'Window', bundleId: systemui, rect: { x: 0, y: 0, width: 1080, height: 63 } },
      { ref: '@e2', depth: 1, type: 'android.widget.TextView', bundleId: systemui, label: '10:17', rect: { x: 11, y: 2, width: 136, height: 58 } },
      { ref: '@e3', depth: 0, type: 'Window', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
      { ref: '@e4', depth: 1, type: 'android.widget.TextView', bundleId: 'dev.e2e.benchmark', label: 'Hello', rect: { x: 0, y: 200, width: 1080, height: 60 } },
    ]);
    expect(projected.viewport).toEqual({ width: 1080, height: 2400 });
    expect(projected.roots.map((root) => root.children?.map((child) => child.name))).toEqual([['Hello']]);
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
      { ref: 'e12', index: 11, parentIndex: 0, depth: 1, type: 'android.widget.AbsListView', identifier: 'fruit-list' },
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
      'abs-list-view',
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
      'list',
    ]);
  });

  it('reads the role and state React Native spells into an iOS accessibility value, and reports the rest as the value', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'Benchmark' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'Other', label: 'Newsletter', value: 'checkbox, unchecked', identifier: 'newsletter-checkbox' },
      { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'Other', label: 'Newsletter', value: 'checkbox, checked' },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'Other', label: 'Small', value: 'radio button, checked', selected: true },
      { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'Other', label: 'Medium', value: 'radio button, unchecked' },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'Other', label: 'Terms', value: 'checkbox, mixed' },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'Other', label: 'Filters', value: 'menu, expanded' },
      { ref: 'e8', index: 7, parentIndex: 0, depth: 1, type: 'Other', label: 'More', value: 'menu, collapsed, busy' },
      { ref: 'e9', index: 8, parentIndex: 0, depth: 1, type: 'Other', label: 'Volume', value: 'spin button, 40%' },
      { ref: 'e10', index: 9, parentIndex: 0, depth: 1, type: 'Other', label: 'Home', value: 'tab', selected: true },
      { ref: 'e11', index: 10, parentIndex: 0, depth: 1, type: 'Other', label: 'Upload', value: 'progress bar, 3 of 5, almost done' },
      { ref: 'e12', index: 11, parentIndex: 0, depth: 1, type: 'Other', label: 'Note', value: 'checkboxes are fun' },
      { ref: 'e13', index: 12, parentIndex: 0, depth: 1, type: 'Switch', label: 'Wi-Fi', value: '1' },
      { ref: 'e14', index: 13, parentIndex: 0, depth: 1, type: 'Other', label: 'Tabs', value: 'tab list' },
    ]);
    const nodes = projected.index.slice(1).map((entry) => entry.node);
    expect(nodes.map((node) => node.role)).toEqual([
      'checkbox',
      'checkbox',
      'radio',
      'radio',
      'checkbox',
      'menu',
      'menu',
      'spinbutton',
      'tab',
      'progressbar',
      'other',
      'switch',
      'tablist',
    ]);
    expect(nodes.map((node) => node.states)).toEqual([
      { checked: false },
      { checked: true },
      { selected: true, checked: true },
      { checked: false },
      undefined,
      { expanded: true },
      { expanded: false },
      undefined,
      { selected: true },
      undefined,
      undefined,
      { checked: true },
      undefined,
    ]);
    // The descriptor and state words are stripped; a value the app set, and a state the contract has no field for, stay.
    expect(nodes.map((node) => node.value)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'mixed',
      undefined,
      'busy',
      '40%',
      undefined,
      '3 of 5, almost done',
      'checkboxes are fun',
      '1',
      undefined,
    ]);
    expect(nodes[0]).toMatchObject({ name: 'Newsletter', testId: 'newsletter-checkbox', selector: 'id=newsletter-checkbox' });
    // The platform kind is kept for selectors: `role=Other` still finds the view.
    expect(projected.index[1]?.kind).toBe('other');
    // Android never writes this shape; a value that happens to start with a word from the list is a value.
    const android = project([{ ref: 'e1', type: 'android.widget.TextView', label: 'Kind', value: 'checkbox, unchecked' }]);
    expect(android.index[0]?.node).toMatchObject({ role: 'text', value: 'checkbox, unchecked' });
    // A native iOS control's value is content, whatever words it starts with: only an `Other` carries the encoding.
    const field = project([{ ref: 'e1', type: 'TextField', label: 'Kind', value: 'checkbox, unchecked' }]);
    expect(field.index[0]?.node).toMatchObject({ role: 'textbox', value: 'checkbox, unchecked' });
    expect(field.index[0]?.node.states?.checked).toBeUndefined();
    // An empty field shows its placeholder, which XCTest reports as the value; the hint flag says it is empty.
    const empty = project([{ ref: 'e1', type: 'TextField', label: 'Name field', value: 'Type your name', hintShowing: true }]);
    expect(empty.index[0]?.node.role).toBe('textbox');
    expect(empty.index[0]?.node.value).toBeUndefined();
    expect(android.index[0]?.node.states).toBeUndefined();
  });

  it('keeps the value of an iOS field whose text is also its label, and drops only the Android text view echo', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'Benchmark' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'TextField', label: 'tester', value: 'tester', identifier: 'username-input' },
      { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'TextView', label: 'Notes long enough', value: 'Notes long enough' },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'StaticText', label: 'Row 1', value: 'Row 1' },
      { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'Airplane mode', value: 'Airplane mode' },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'android.widget.EditText', label: 'tester', value: 'tester' },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'PIN', value: 'PIN', editable: true },
      { ref: 'e8', index: 7, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'Total', value: '42' },
    ]);
    expect(projected.index.slice(1).map((entry) => [entry.node.role, entry.node.value])).toEqual([
      ['textbox', 'tester'],
      ['textbox', 'Notes long enough'],
      ['text', 'Row 1'],
      ['text', undefined],
      ['textbox', 'tester'],
      ['textbox', 'PIN'],
      ['text', '42'],
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

  it('marks an Android password EditText secure by attribute and leaves a plain EditText its value', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'android.widget.EditText', label: 'Email', value: 'oskar@example.com', editable: true, password: false },
      { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'android.widget.EditText', label: 'Password', value: 'hunter2', editable: true, password: true, identifier: 'com.example:id/password', rect: { x: 0, y: 270, width: 390, height: 44 } },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'com.example.PinView', label: 'PIN', value: '1234', editable: true, password: true },
      { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'Forgot?', editable: false },
    ]);
    const [, email, password, pin, note] = projected.index.map((entry) => entry.node);
    expect(email).toMatchObject({ role: 'textbox', name: 'Email', value: 'oskar@example.com' });
    expect(email!.states).toBeUndefined();
    expect(email!.inputPurpose).toBeUndefined();
    expect(password).toMatchObject({ role: 'textbox', name: 'Password', inputPurpose: 'password', states: { secure: true }, testId: 'com.example:id/password' });
    expect(password!.value).toBeUndefined();
    // A custom input class the maps do not know is a textbox once the platform says it is editable.
    expect(projected.index[3]!.kind).toBe('pin-view');
    expect(pin).toMatchObject({ role: 'textbox', inputPurpose: 'password', states: { secure: true } });
    expect(pin!.value).toBeUndefined();
    expect(note!.role).toBe('text');
  });

  it('keeps a role that already takes text when the platform reports it editable, and trusts the flag on a control role', () => {
    const projected = project([
      { ref: 'e1', type: 'searchbox', label: 'Search', editable: true },
      { ref: 'e2', type: 'android.widget.Spinner', label: 'Country', editable: true },
      { ref: 'e3', type: 'android.widget.Button', label: 'Submit', editable: true },
      { ref: 'e4', type: 'android.widget.Button', label: 'Cancel', editable: false },
      { ref: 'e5', type: 'android.widget.Button', label: 'Later' },
    ]);
    expect(projected.index.map((entry) => entry.node.role)).toEqual(['searchbox', 'combobox', 'textbox', 'button', 'button']);
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
