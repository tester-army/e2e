import { describe, expect, it } from 'vitest';
import { keyboardBand, keyboardUnplaced, projectSnapshot, screenTitle, viewportOf, type RawNode } from '../../src/nodes.ts';
import { keyboardDragStart } from '../../src/keyboard.ts';
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

  it('measures system bars against a published viewport, where the tree alone would end the screen at its lowest window', () => {
    const systemui = 'com.android.systemui';
    // A panel above the bottom of a 2400 px screen, at the bottom of a tree that reaches only 1800 px.
    const nodes: RawNode[] = [
      { ref: '@e1', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 1800 } },
      { ref: '@e2', depth: 0, type: 'android.widget.FrameLayout', bundleId: systemui, rect: { x: 0, y: 1700, width: 1080, height: 100 } },
    ];
    const published = projectSnapshot(nodes, { mintId: () => 'n', viewport: { width: 1080, height: 2400 } });
    expect(published.viewport).toEqual({ width: 1080, height: 2400 });
    expect(published.roots).toHaveLength(2);
    const inferred = projectSnapshot(nodes, { mintId: () => 'n' });
    expect(inferred.viewport).toEqual({ width: 1080, height: 1800 });
    expect(inferred.roots).toHaveLength(1);
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

  it('leaves out status icons agent-device reports as top-level nodes of their own, and keeps a wide popup and a narrow one with a control in the same band', () => {
    const systemui = 'com.android.systemui';
    const projected = project([
      { ref: '@e1', type: 'android.widget.TextView', bundleId: systemui, label: '11:25', identifier: 'com.android.systemui:id/clock', rect: { x: 47, y: 47, width: 125, height: 43 } },
      { ref: '@e2', type: 'android.widget.ImageView', bundleId: systemui, label: 'Android System notification: ', rect: { x: 172, y: 1, width: 58, height: 135 } },
      { ref: '@e3', type: 'android.widget.FrameLayout', bundleId: systemui, label: 'T-Mobile, two bars.', identifier: 'com.android.systemui:id/mobile_combo', rect: { x: 930, y: 39, width: 39, height: 58 } },
      { ref: '@e4', type: 'android.widget.FrameLayout', bundleId: systemui, label: 'Download complete', rect: { x: 40, y: 20, width: 1000, height: 150 } },
      { ref: '@e5', index: 5, depth: 0, type: 'android.widget.FrameLayout', bundleId: systemui, label: 'Screen recording', rect: { x: 80, y: 0, width: 400, height: 140 } },
      { ref: '@e6', index: 6, depth: 1, parentIndex: 5, type: 'android.widget.Button', bundleId: systemui, label: 'Stop', rect: { x: 300, y: 40, width: 120, height: 60 } },
      { ref: '@e7', depth: 0, type: 'android.widget.FrameLayout', bundleId: 'dev.e2e.benchmark', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
    ]);
    expect(projected.roots.map((root) => root.name)).toEqual(['Download complete', 'Screen recording', undefined]);
    expect(projected.index.map((entry) => entry.node.name)).toContain('Stop');
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

  it('reads the XCUIElementType class names a WebDriver session reports as the native XCTest types', () => {
    const native: RawNode[] = [
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'Profiler', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'NavigationBar', identifier: 'Profiler' },
      { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'StaticText', label: 'Profiler' },
      { ref: 'e4', index: 3, parentIndex: 0, depth: 1, type: 'Button', label: 'CPU Load' },
      { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'TextView', label: 'Notes', value: 'idle' },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'TabBar' },
      { ref: 'e7', index: 6, parentIndex: 5, depth: 2, type: 'Button', label: 'Home', selected: true },
      { ref: 'e8', index: 7, parentIndex: 5, depth: 2, type: 'Button', label: 'Settings' },
    ];
    const webDriver = native.map((node) => ({ ...node, type: `XCUIElementType${node.type}` }));
    const kindsAndRoles = (nodes: readonly RawNode[]) => project(nodes).index.map((entry) => [entry.kind, entry.node.role]);
    expect(kindsAndRoles(webDriver)).toEqual(kindsAndRoles(native));
    expect(project(webDriver).viewport).toEqual({ width: 390, height: 844 });
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

  it('names an Android node by its content description, keeps its text, and reads heading, role description, checked, and placeholder', () => {
    const projected = project([
      { ref: 'e1', index: 0, depth: 0, type: 'android.widget.FrameLayout' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'Plain controls, every state exposed', contentDescription: 'Inventory heading', heading: true, identifier: 'inventory-header' },
      { ref: 'e3', index: 2, parentIndex: 0, depth: 1, type: 'android.view.View', roleDescription: 'Tab List' },
      { ref: 'e4', index: 3, parentIndex: 2, depth: 2, type: 'android.view.View', label: 'Fields', roleDescription: 'Tab', selected: true },
      { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'android.widget.EditText', label: 'Ada Lovelace', value: 'Ada Lovelace', contentDescription: 'Name field', placeholder: 'Type your name', editable: true },
      { ref: 'e6', index: 5, parentIndex: 0, depth: 1, type: 'android.widget.EditText', label: 'Type your name', value: 'Type your name', contentDescription: 'Name field', placeholder: 'Type your name', hintShowing: true, editable: true },
      { ref: 'e7', index: 6, parentIndex: 0, depth: 1, type: 'android.widget.Switch', label: 'Wi-Fi switch', checked: false },
      { ref: 'e8', index: 7, parentIndex: 0, depth: 1, type: 'android.widget.RadioButton', label: 'Medium', checked: true },
      { ref: 'e9', index: 8, parentIndex: 0, depth: 1, type: 'android.view.View', label: 'Plain', roleDescription: 'Link' },
      { ref: 'e10', index: 9, parentIndex: 0, depth: 1, type: 'android.widget.TextView', label: 'Total', contentDescription: '' },
    ]);
    const [, header, tablist, tab, filled, empty, toggle, radio, plain, total] = projected.index.map((entry) => entry.node);
    expect(header).toMatchObject({ role: 'heading', name: 'Inventory heading', text: 'Plain controls, every state exposed', testId: 'inventory-header' });
    expect(tablist?.role).toBe('tablist');
    expect(tab).toMatchObject({ role: 'tab', name: 'Fields', text: 'Fields', states: { selected: true } });
    expect(filled).toMatchObject({ role: 'textbox', name: 'Name field', text: 'Ada Lovelace', value: 'Ada Lovelace', attributes: { placeholder: 'Type your name' } });
    // An empty field shows its hint as its text; the hint flag says it holds nothing.
    expect(empty).toMatchObject({ role: 'textbox', name: 'Name field', text: 'Type your name', attributes: { placeholder: 'Type your name' } });
    expect(empty?.value).toBeUndefined();
    expect(toggle).toMatchObject({ role: 'switch', name: 'Wi-Fi switch', states: { checked: false } });
    expect(radio).toMatchObject({ role: 'radio', states: { checked: true } });
    // A role description outside the vocabulary leaves the class role; an empty description leaves the label as the name.
    expect(plain).toMatchObject({ role: 'group', name: 'Plain' });
    expect(total).toMatchObject({ role: 'text', name: 'Total', text: 'Total' });
    expect(total?.attributes).toBeUndefined();
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
    // An empty iOS field reports its placeholder as its value, with no flag saying so (examples/with-expo's TextInput, agent-device 0.21.28, iOS 26.5).
    const empty = project([{ ref: 'e1', type: 'TextField', label: 'Name', value: 'Ada Lovelace', placeholder: 'Ada Lovelace', identifier: 'name', editable: true }]);
    expect(empty.index[0]?.node).toMatchObject({ role: 'textbox', name: 'Name', attributes: { placeholder: 'Ada Lovelace' } });
    expect(empty.index[0]?.node.value).toBeUndefined();
    // Typed text that differs from the placeholder is the value.
    const typed = project([{ ref: 'e1', type: 'TextField', label: 'Name', value: 'Ada', placeholder: 'Ada Lovelace', editable: true }]);
    expect(typed.index[0]?.node.value).toBe('Ada');
    // A static text whose value matches some placeholder is not a field showing its hint.
    const text = project([{ ref: 'e1', type: 'StaticText', label: 'Hint', value: 'Ada Lovelace', placeholder: 'Ada Lovelace' }]);
    expect(text.index[0]?.node.value).toBe('Ada Lovelace');
    expect(android.index[0]?.node.states).toBeUndefined();
  });

  it('reads the placeholder an empty Compose Multiplatform field folds into its label', () => {
    // examples/with-kotlin-multiplatform on iOS 27 (agent-device 0.21.33's XCTest tree, Compose Multiplatform 1.12.1):
    // the field has no placeholder attribute; it appends the text it draws to its label.
    const field = (label: string, children: readonly RawNode[], extra: RawNode = {}) => project([
      { ref: 'e1', index: 0, depth: 0, type: 'Application', label: 'with-kotlin-multiplatform' },
      { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'TextView', label, identifier: 'name', editable: true, ...extra },
      ...children.map((child, offset) => ({ ref: `e${3 + offset}`, index: 2 + offset, parentIndex: 1, depth: 2, ...child })),
    ]);
    const hint = { type: 'StaticText', label: 'Ada Lovelace' };
    const empty = field('Name, Ada Lovelace', [hint]);
    expect(empty.index.map((entry) => entry.node.name)).toEqual(['with-kotlin-multiplatform', 'Name']);
    expect(empty.index[1]?.node).toMatchObject({ role: 'textbox', name: 'Name', attributes: { placeholder: 'Ada Lovelace' } });
    expect(empty.index[1]?.node.children).toBeUndefined();
    // Typed text drops the placeholder from the label and is the value.
    const typed = field('Name', [], { value: 'Grace' });
    expect(typed.index[1]?.node).toMatchObject({ name: 'Name', value: 'Grace' });
    // Anything but one text that ends the label stays as reported.
    for (const [label, children, extra] of [
      ['Name, Ada Lovelace', [hint], { value: 'Ada' }],
      ['Name, Ada Lovelace', [hint], { editable: false, type: 'Other' }],
      ['Name, Ada Lovelace', [hint, { type: 'Button', label: 'Clear' }], {}],
      ['Name, Ada Lovelace', [{ type: 'Image', label: 'Ada Lovelace' }], {}],
      ['Name, Grace Hopper', [hint], {}],
      // A label equal to the text it holds may be the field's own name (a Material label drawn inside).
      ['Ada Lovelace', [hint], {}],
    ] as const) {
      const kept = field(label, children, extra).index[1]?.node;
      expect(kept?.name).toBe(label);
      expect(kept?.attributes).toBeUndefined();
      expect(kept?.children).toHaveLength(children.length);
    }
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

  it('reads an iOS title from the bar identifier only when the bar shows that text', () => {
    expect(screenTitle(project(SETTINGS_NODES))).toBe('General');
    const pushed = project([
      { ref: '@e1', depth: 0, type: 'NavigationBar', label: 'Benchmark Examples', identifier: 'Today' },
      { ref: '@e2', depth: 1, type: 'Button', label: 'Benchmark Examples' },
      { ref: '@e3', depth: 1, type: 'StaticText', label: 'Today' },
    ]);
    expect(screenTitle(pushed)).toBe('Today');
    expect(screenTitle(project([{ ref: '@e1', type: 'NavigationBar', identifier: 'About' }]))).toBeUndefined();
    expect(screenTitle(project([{ ref: '@e1', depth: 0, type: 'NavigationBar', identifier: 'MyApp.InboxController' }, { ref: '@e2', depth: 1, type: 'Button', label: 'Back' }]))).toBeUndefined();
    const untitled = project([
      { ref: '@e1', depth: 0, type: 'NavigationBar', identifier: '_TtGC7SwiftUI32NavigationStackHosting' },
      { ref: '@e2', depth: 1, type: 'Button', label: 'Share' },
    ]);
    expect(screenTitle(untitled)).toBeUndefined();
    const textOnly = project([
      { ref: '@e1', depth: 0, type: 'navigation-bar' },
      { ref: '@e2', depth: 1, type: 'static-text', label: 'About' },
    ]);
    expect(screenTitle(textOnly)).toBeUndefined();
    expect(screenTitle(project([{ ref: '@e1', type: 'NavigationBar', label: 'Settings', identifier: ' ' }]))).toBeUndefined();
    expect(screenTitle(project([{ ref: '@e1', type: 'button', label: 'Go' }]))).toBeUndefined();
  });

  it("never reads an Android toolbar's resource id as its title", () => {
    const untitled = project([{ ref: 'e1', type: 'android.view.ViewGroup', identifier: 'com.example:id/toolbar' }]);
    expect(screenTitle(untitled)).toBeUndefined();
  });
});

describe('nodes under the soft keyboard', () => {
  const KEYBOARD = { x: 0, y: 566, width: 402, height: 308 };
  /**
   * The shape XCTest reports for a form with the keyboard up: the keyboard's
   * window first, then the app. The Brand field and the Continue row sit under
   * the keyboard; the Product name field, the form, and the suggestion bar
   * agent-device marks keyboard-owned do not.
   */
  const FORM: readonly RawNode[] = [
    { ref: '@e0', index: 0, depth: 0, type: 'Application', label: 'Shop', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: '@e2', index: 2, parentIndex: 1, depth: 2, type: 'Other', rect: { x: 0, y: 566, width: 402, height: 308 } },
    { ref: '@e3', index: 3, parentIndex: 2, depth: 3, type: 'Keyboard', rect: { x: 0, y: 583, width: 402, height: 233 } },
    { ref: '@e4', index: 4, parentIndex: 3, depth: 4, type: 'Key', label: 'q', rect: { x: 4, y: 590, width: 39, height: 54 } },
    { ref: '@e5', index: 5, parentIndex: 3, depth: 4, type: 'Button', label: 'return', rect: { x: 300, y: 752, width: 99, height: 54 } },
    { ref: '@e6', index: 6, parentIndex: 2, depth: 3, type: 'Button', label: 'Dictate', keyboardOwned: true, rect: { x: 325, y: 805, width: 68, height: 68 } },
    // The keyboard's window holds its dock; agent-device does not always mark the dock keyboard-owned.
    { ref: '@e14', index: 14, parentIndex: 2, depth: 3, type: 'Button', label: 'Next keyboard', rect: { x: 8, y: 805, width: 68, height: 68 } },
    { ref: '@e7', index: 7, parentIndex: 0, depth: 1, type: 'Other', label: 'Form', rect: { x: 0, y: 116, width: 402, height: 758 } },
    { ref: '@e8', index: 8, parentIndex: 7, depth: 2, type: 'TextField', label: 'Product name', rect: { x: 24, y: 200, width: 354, height: 44 } },
    { ref: '@e9', index: 9, parentIndex: 7, depth: 2, type: 'TextField', label: 'Brand', identifier: 'brand', rect: { x: 24, y: 600, width: 354, height: 44 } },
    { ref: '@e10', index: 10, parentIndex: 7, depth: 2, type: 'Other', label: 'Continue', rect: { x: 24, y: 806, width: 354, height: 44 } },
    { ref: '@e11', index: 11, parentIndex: 10, depth: 3, type: 'StaticText', label: 'Continue', rect: { x: 160, y: 818, width: 80, height: 20 } },
    // A row whose top shows above the keyboard while its centre is under it: the label child shows, so the row does.
    { ref: '@e12', index: 12, parentIndex: 7, depth: 2, type: 'Cell', label: 'Notes', rect: { x: 0, y: 520, width: 402, height: 120 } },
    { ref: '@e13', index: 13, parentIndex: 12, depth: 3, type: 'StaticText', label: 'Notes', rect: { x: 24, y: 528, width: 80, height: 20 } },
  ];
  const projectWith = (keyboard: { x: number; y: number; width: number; height: number } | undefined) => {
    let counter = 0;
    return projectSnapshot(FORM, { mintId: () => `n${(counter += 1)}`, keyboard });
  };
  const hiddenNames = (keyboard: Parameters<typeof projectWith>[0]) =>
    projectWith(keyboard)
      .index.filter((entry) => entry.node.states?.hidden === true)
      .map((entry) => entry.node.name);

  it('hides a node whose centre the keyboard covers and none of whose children shows', () => {
    expect(hiddenNames(KEYBOARD)).toEqual(['Brand', 'Continue', 'Continue']);
  });

  it("keeps the keyboard's own nodes, a straddling row with a label above the keyboard, and everything above it", () => {
    const { index } = projectWith(KEYBOARD);
    const byName = (name: string) => index.find((entry) => entry.node.name === name)!.node;
    for (const name of ['q', 'return', 'Dictate', 'Next keyboard', 'Product name', 'Form', 'Notes', 'Shop']) {
      expect(byName(name).states?.hidden, name).toBeUndefined();
    }
  });

  it('keeps the dock that follows the keyboard element under the same parent, and the focused field', () => {
    // The shape agent-device's iOS 27 simulator capture reports: no window, the app first, then the
    // keyboard and its dock as siblings. The focused search field reports a frame from before the
    // keyboard came up, under the keyboard, while the screen draws it above.
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { ref: '@e0', index: 0, depth: 0, type: 'Application', label: 'Settings', rect: { x: 0, y: 0, width: 402, height: 874 } },
        { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: 'Button', label: 'Passwords', rect: { x: 16, y: 718, width: 370, height: 52 } },
        { ref: '@e2', index: 2, parentIndex: 0, depth: 1, type: 'SearchField', label: 'Search', focused: true, rect: { x: 26, y: 789, width: 344, height: 28 } },
        { ref: '@e3', index: 3, parentIndex: 0, depth: 1, type: 'Keyboard', rect: { x: 0, y: 590, width: 402, height: 226 } },
        { ref: '@e4', index: 4, parentIndex: 0, depth: 1, type: 'Button', label: 'Next keyboard', rect: { x: 8, y: 805, width: 68, height: 68 } },
      ],
      { mintId: () => `n${(counter += 1)}`, keyboard: { x: 0, y: 590, width: 402, height: 284 } },
    );
    expect(index.filter((entry) => entry.node.states?.hidden === true).map((entry) => entry.node.name)).toEqual(['Passwords']);
  });

  it('hides app content listed after a keyboard that has no window, above the dock', () => {
    // Keyboard first, then the app: a later sibling that starts above the band is app content.
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { ref: '@e0', index: 0, depth: 0, type: 'Application', label: 'Shop', rect: { x: 0, y: 0, width: 402, height: 874 } },
        { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: 'Keyboard', rect: { x: 0, y: 500, width: 402, height: 300 } },
        { ref: '@e2', index: 2, parentIndex: 0, depth: 1, type: 'Button', label: 'Next keyboard', rect: { x: 8, y: 805, width: 68, height: 68 } },
        { ref: '@e3', index: 3, parentIndex: 0, depth: 1, type: 'Other', label: 'Form', rect: { x: 0, y: 116, width: 402, height: 758 } },
        { ref: '@e4', index: 4, parentIndex: 3, depth: 2, type: 'Button', label: 'Continue', rect: { x: 24, y: 650, width: 354, height: 40 } },
      ],
      { mintId: () => `n${(counter += 1)}`, keyboard: { x: 0, y: 500, width: 402, height: 374 } },
    );
    expect(index.filter((entry) => entry.node.states?.hidden === true).map((entry) => entry.node.name)).toEqual(['Continue']);
  });

  it('reads the band off keys a capture lists with no keyboard element around them', () => {
    const keys: RawNode[] = [
      { ref: '@e0', index: 0, depth: 0, type: 'Application', label: 'Shop', rect: { x: 0, y: 0, width: 402, height: 874 } },
      { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: 'Key', label: 'q', rect: { x: 4, y: 590, width: 39, height: 54 } },
      { ref: '@e2', index: 2, parentIndex: 0, depth: 1, type: 'Key', label: 'p', rect: { x: 360, y: 590, width: 39, height: 54 } },
    ];
    expect(keyboardBand(keys, undefined, undefined)).toEqual({ x: 4, y: 590, width: 395, height: 284 });
  });

  it('hides nothing when the producer measured no keyboard frame', () => {
    expect(hiddenNames(undefined)).toEqual([]);
  });

  it('keeps a node beside a keyboard that does not span the screen', () => {
    expect(hiddenNames({ x: 0, y: 566, width: 150, height: 308 })).toEqual([]);
  });
});

describe('nodes agent-device marks covered (tester-army/e2e#1324)', () => {
  const SCREEN = { width: 390, height: 844 };

  it('reads a covered node as hidden, named cover or not, and leaves the rest as they were', () => {
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'TextField', identifier: 'named', interactionBlocked: 'covered', coveredBy: { kind: 'button', label: 'Next' }, rect: { x: 16, y: 372, width: 358, height: 48 } },
        { index: 2, parentIndex: 0, type: 'TextField', identifier: 'unnamed', interactionBlocked: 'covered', rect: { x: 16, y: 430, width: 358, height: 48 } },
        { index: 3, parentIndex: 0, type: 'TextField', identifier: 'clear', rect: { x: 16, y: 300, width: 358, height: 48 } },
        // With no keyboard up, agent-device's mark hides even the focused field.
        { index: 4, parentIndex: 0, type: 'TextField', identifier: 'focused', focused: true, interactionBlocked: 'covered', rect: { x: 16, y: 600, width: 358, height: 48 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    const byId = (id: string) => index.find((entry) => entry.node.testId === id);
    expect(byId('named')?.node.states).toEqual({ hidden: true });
    expect(byId('unnamed')?.node.states).toEqual({ hidden: true });
    expect(byId('clear')?.node.states).toBeUndefined();
    expect(byId('focused')?.node.states).toEqual({ focused: true, hidden: true });
  });

  it('keeps a covered control out of where a keyboard-dismissing drag may start', () => {
    // A button at the screen's middle, where the drag would otherwise start, marked covered by a cover the tree leaves out.
    const save = { x: 145, y: 372, width: 100, height: 100 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Save', interactionBlocked: 'covered', rect: save },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    const start = keyboardDragStart(projected, SCREEN, 700);
    expect(start).toBeDefined();
    const inside = start!.x >= save.x - 8 && start!.x <= save.x + save.width + 8 && start!.y >= save.y - 8 && start!.y <= save.y + save.height + 8;
    expect(inside).toBe(false);
  });

  it("lets the keyboard's rules decide under the Android keyboard, which agent-device counts as a cover", () => {
    // agent-device marks every app node whose centre is under the IME covered.
    const app = 'dev.e2e.benchmark';
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'android.widget.FrameLayout', bundleId: app, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
        { index: 1, parentIndex: 0, type: 'android.widget.EditText', bundleId: app, identifier: 'brand', focused: true, interactionBlocked: 'covered', rect: { x: 24, y: 1600, width: 1032, height: 120 } },
        // A row whose centre is under the keyboard and whose label shows above it.
        { index: 2, parentIndex: 0, type: 'android.view.ViewGroup', bundleId: app, identifier: 'notes-row', interactionBlocked: 'covered', rect: { x: 0, y: 1380, width: 1080, height: 300 } },
        { index: 3, parentIndex: 2, type: 'android.widget.TextView', bundleId: app, identifier: 'notes-label', label: 'Notes', rect: { x: 24, y: 1400, width: 200, height: 50 } },
        { index: 4, parentIndex: 0, type: 'android.widget.TextView', bundleId: app, identifier: 'footnote', label: 'Prices include tax', interactionBlocked: 'covered', rect: { x: 24, y: 2000, width: 600, height: 60 } },
      ],
      { mintId: () => `n${++counter}`, viewport: { width: 1080, height: 2400 }, keyboard: { x: 0, y: 1500, width: 1080, height: 900 } },
    );
    const byId = (id: string) => index.find((entry) => entry.node.testId === id)?.node.states;
    expect(byId('brand')).toEqual({ focused: true });
    expect(byId('notes-row')).toBeUndefined();
    expect(byId('notes-label')).toBeUndefined();
    expect(byId('footnote')).toEqual({ hidden: true });
  });

  it("reads agent-device's mark as hiding nothing while a keyboard it could not measure may be up", () => {
    // agent-device marks nodes under an IME it could not measure covered, and leaves e2e no band.
    const app = 'dev.e2e.benchmark';
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'android.widget.FrameLayout', bundleId: app, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
        { index: 1, parentIndex: 0, type: 'android.widget.EditText', bundleId: app, identifier: 'brand', focused: true, interactionBlocked: 'covered', rect: { x: 24, y: 1600, width: 1032, height: 120 } },
        { index: 2, parentIndex: 0, type: 'android.widget.TextView', bundleId: app, identifier: 'title', label: 'Checkout', interactionBlocked: 'covered', rect: { x: 24, y: 200, width: 600, height: 60 } },
      ],
      { mintId: () => `n${++counter}`, viewport: { width: 1080, height: 2400 }, keyboardUnplaced: true },
    );
    expect(index.find((entry) => entry.node.testId === 'brand')?.node.states).toEqual({ focused: true });
    expect(index.find((entry) => entry.node.testId === 'title')?.node.states).toBeUndefined();
  });

  it('counts an Android keyboard as unplaced only when agent-device saw one, or could not tell, and no band was read', () => {
    const band = { x: 0, y: 1500, width: 1080, height: 900 };
    expect(keyboardUnplaced({ kind: 'unmeasurable', reason: 'window-region-not-rectangular' }, undefined, 'android')).toBe(true);
    expect(keyboardUnplaced({ kind: 'unmeasurable', reason: 'window-list-unavailable' }, undefined, 'android')).toBe(true);
    expect(keyboardUnplaced({ kind: 'visibility-only', visible: true }, undefined, 'android')).toBe(true);
    expect(keyboardUnplaced({ kind: 'tree-rejected', derivation: 'docked-tree' }, undefined, 'android')).toBe(true);
    expect(keyboardUnplaced({ kind: 'tree-rejected', derivation: 'docked-tree', visible: false }, undefined, 'android')).toBe(false);
    expect(keyboardUnplaced({ kind: 'visibility-only', visible: false }, undefined, 'android')).toBe(false);
    expect(keyboardUnplaced({ kind: 'absent' }, undefined, 'android')).toBe(false);
    expect(keyboardUnplaced(undefined, undefined, 'android')).toBe(false);
    // A band read off the tree places the keyboard, whatever the fact says.
    expect(keyboardUnplaced({ kind: 'unmeasurable', reason: 'capture-truncated' }, band, 'android')).toBe(false);
    // agent-device never counts the iOS keyboard as a cover, so an unmeasured one leaves the mark alone.
    expect(keyboardUnplaced({ kind: 'unmeasurable', reason: 'keyboard-not-observed' }, undefined, 'ios')).toBe(false);
  });

  it("tests the keyboard at the rounded centre agent-device tests a cover at", () => {
    // Height 117 puts the centre at 1499.5: agent-device rounds it to 1500, inside the keyboard, and marks the nodes covered.
    const app = 'dev.e2e.benchmark';
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'android.widget.FrameLayout', bundleId: app, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
        { index: 1, parentIndex: 0, type: 'android.widget.EditText', bundleId: app, identifier: 'brand', focused: true, interactionBlocked: 'covered', rect: { x: 24, y: 1441, width: 1032, height: 117 } },
        { index: 2, parentIndex: 0, type: 'android.widget.TextView', bundleId: app, identifier: 'hint', label: 'Required', interactionBlocked: 'covered', rect: { x: 24, y: 1441, width: 300, height: 117 } },
      ],
      { mintId: () => `n${++counter}`, viewport: { width: 1080, height: 2400 }, keyboard: { x: 0, y: 1500, width: 1080, height: 900 } },
    );
    expect(index.find((entry) => entry.node.testId === 'brand')?.node.states).toEqual({ focused: true });
    expect(index.find((entry) => entry.node.testId === 'hint')?.node.states).toBeUndefined();
  });

  it('tests the keyboard at the rounded centre across too, as for a one-handed keyboard', () => {
    // Width 539 puts the centre at x 269.5: agent-device rounds it to 270, inside a keyboard that starts there.
    const app = 'dev.e2e.benchmark';
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'android.widget.FrameLayout', bundleId: app, rect: { x: 0, y: 0, width: 1080, height: 2400 } },
        { index: 1, parentIndex: 0, type: 'android.widget.TextView', bundleId: app, identifier: 'hint', label: 'Required', interactionBlocked: 'covered', rect: { x: 0, y: 1600, width: 539, height: 120 } },
      ],
      { mintId: () => `n${++counter}`, viewport: { width: 1080, height: 2400 }, keyboard: { x: 270, y: 1500, width: 810, height: 900 } },
    );
    expect(index.find((entry) => entry.node.testId === 'hint')?.node.states).toBeUndefined();
  });

  it("keeps the keyboard's own dock visible though agent-device marks it covered", () => {
    // XCTest can list the keyboard before an app whose tab bar agent-device then reads as drawn over the dock.
    const KEYBOARD = { x: 0, y: 566, width: 402, height: 308 };
    let counter = 0;
    const { index } = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Shop', rect: { x: 0, y: 0, width: 402, height: 874 } },
        { index: 1, parentIndex: 0, depth: 1, type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
        { index: 2, parentIndex: 1, depth: 2, type: 'Other', rect: { x: 0, y: 566, width: 402, height: 308 } },
        { index: 3, parentIndex: 2, depth: 3, type: 'Keyboard', rect: { x: 0, y: 583, width: 402, height: 233 } },
        { index: 4, parentIndex: 3, depth: 4, type: 'Key', label: 'q', rect: { x: 4, y: 590, width: 39, height: 54 } },
        { index: 5, parentIndex: 2, depth: 3, type: 'Button', label: 'Next keyboard', interactionBlocked: 'covered', rect: { x: 8, y: 805, width: 68, height: 68 } },
        { index: 6, parentIndex: 0, depth: 1, type: 'TabBar', label: 'Tab Bar', rect: { x: 0, y: 791, width: 402, height: 83 } },
      ],
      { mintId: () => `n${++counter}`, keyboard: KEYBOARD },
    );
    expect(index.find((entry) => entry.node.name === 'q')?.node.states).toBeUndefined();
    expect(index.find((entry) => entry.node.name === 'Next keyboard')?.node.states).toBeUndefined();
  });

  it('starts a keyboard-dismissing drag on a node the platform reports not shown', () => {
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Save', visibleToUser: false, rect: { x: 145, y: 372, width: 100, height: 100 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(projected, SCREEN, 700)).toEqual({ x: 195, y: 422 });
  });
});
