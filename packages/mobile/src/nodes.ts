/**
 * Projection of an agent-device accessibility snapshot onto the contract's
 * `SemanticNode` tree. agent-device hands back a flat list with tree
 * coordinates (`index`, `parentIndex`, `depth`) and platform element types;
 * this module rebuilds the tree, maps the types onto the closed role
 * vocabulary `screen.getByRole` and trace relocation speak, and mints the
 * ids the surface owns.
 */

import type { SemanticNode, ViewportSize } from 'e2e/engine';
import type { Rect } from './support.ts';

/** The subset of an agent-device snapshot node this engine reads. */
export interface RawNode {
  readonly ref?: string;
  readonly index?: number;
  readonly parentIndex?: number;
  readonly depth?: number;
  readonly type?: string;
  readonly role?: string;
  readonly label?: string;
  readonly value?: string;
  readonly identifier?: string;
  readonly rect?: Rect;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly focused?: boolean;
  /** Native accessibility facts; absent means unavailable, not false. */
  readonly editable?: boolean;
  readonly password?: boolean;
  readonly visibleToUser?: boolean;
  readonly hittable?: boolean;
  readonly appName?: string;
  readonly windowTitle?: string;
}

/** One projected node with what the surface needs to act on it and to answer selector terms. */
export interface ProjectedNode {
  readonly id: string;
  /** agent-device ref without its `@` prefix; empty for a node the runner cannot act on. */
  readonly ref: string;
  /** Platform element type, lower-cased (`text-field`, `cell`, `navigation-bar`). */
  readonly kind: string;
  readonly raw: RawNode;
  readonly node: SemanticNode;
  readonly parent: ProjectedNode | undefined;
}

export interface ProjectedSnapshot {
  /** The device's top-level elements (windows, the application node); the surface wraps them in one root. */
  readonly roots: readonly SemanticNode[];
  /** Every node in document order, parents before children. */
  readonly index: readonly ProjectedNode[];
  readonly viewport: ViewportSize | undefined;
}

/**
 * Platform element types onto the role vocabulary. Anything not listed keeps
 * its lower-cased type as the role, so no information is lost; the map only
 * makes the common controls answer the same `getByRole` a browser does.
 */
const ROLE_MAP: Readonly<Record<string, string>> = {
  button: 'button',
  link: 'link',
  'text-field': 'textbox',
  textfield: 'textbox',
  'search-field': 'textbox',
  'text-view': 'textbox',
  'edit-text': 'textbox',
  'secure-text-field': 'textbox',
  securetextfield: 'textbox',
  switch: 'switch',
  toggle: 'switch',
  checkbox: 'checkbox',
  'check-box': 'checkbox',
  slider: 'slider',
  image: 'image',
  'image-view': 'image',
  'static-text': 'text',
  text: 'text',
  cell: 'listitem',
  'list-item': 'listitem',
  'table-cell': 'listitem',
  'collection-cell': 'listitem',
  tab: 'tab',
  'tab-bar-item': 'tab',
  'tab-bar-button': 'tab',
  'tab-bar': 'tablist',
  'tab-group': 'tablist',
  'segmented-control': 'tablist',
  menu: 'menu',
  'menu-bar': 'menubar',
  'menu-item': 'menuitem',
  'menu-bar-item': 'menuitem',
  'menu-button': 'menuitem',
  toolbar: 'toolbar',
  'radio-group': 'radiogroup',
  'radio-button': 'radio',
  stepper: 'spinbutton',
  'table-row': 'row',
  alert: 'alert',
  dialog: 'dialog',
  sheet: 'dialog',
  'action-sheet': 'dialog',
  heading: 'heading',
  header: 'heading',
  'navigation-bar': 'navigation',
  // A spinner says something is happening; a bar says how far along it is.
  'activity-indicator': 'status',
  'progress-indicator': 'progressbar',
};

const SECURE_KINDS = new Set(['secure-text-field', 'securetextfield', 'password-field']);
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const CHECKABLE_ROLES = new Set(['switch', 'checkbox']);
const CHECKED_VALUES = new Set(['1', 'on', 'true', 'checked', 'selected']);
const UNCHECKED_VALUES = new Set(['0', 'off', 'false', 'unchecked']);
const SCREEN_KINDS = new Set(['application', 'app', 'window']);

/**
 * The role descriptions React Native writes into an iOS view's accessibility
 * value for the roles UIKit has no trait for, onto the contract role each
 * stands for. Fabric (`RCTViewComponentView.mm`) writes `checkbox` and
 * `radio button`; Paper (`RCTView.m`) writes the whole list.
 */
const REACT_NATIVE_ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  alert: 'alert',
  checkbox: 'checkbox',
  'combo box': 'combobox',
  menu: 'menu',
  'menu bar': 'menubar',
  'menu item': 'menuitem',
  'progress bar': 'progressbar',
  'radio button': 'radio',
  'radio group': 'radiogroup',
  'scroll bar': 'scrollbar',
  'spin button': 'spinbutton',
  switch: 'switch',
  tab: 'tab',
  'tab list': 'tablist',
  timer: 'timer',
  'tool bar': 'toolbar',
};

/** The state words React Native writes after the role description, and the state each one sets. */
const REACT_NATIVE_STATE_WORDS: Readonly<Record<string, { readonly checked?: boolean; readonly expanded?: boolean }>> = {
  checked: { checked: true },
  unchecked: { checked: false },
  expanded: { expanded: true },
  collapsed: { expanded: false },
};

/** State words with no contract state (`mixed`, `busy`): kept in the value, so they still read. */
const REACT_NATIVE_LOOSE_STATE_WORDS = new Set(['mixed', 'busy']);

/** What React Native spelled into an iOS accessibility value. */
interface ReactNativeValue {
  readonly role: string;
  readonly states: { readonly checked?: boolean; readonly expanded?: boolean };
  /** The value proper, after the role and state words; undefined when nothing follows them. */
  readonly value: string | undefined;
}

/**
 * React Native has no UIKit trait for `checkbox`, `radio`, and the other
 * roles above, so on iOS it spells the role and the checked or expanded
 * state into the view's accessibility value, comma-separated and before any
 * value the app set: `checkbox, unchecked`, `radio button, checked`. XCTest
 * then reports an `Other` whose value says what it is. This reads that
 * shape back: the role from the leading description, the states from the
 * words after it, and what follows as the value proper. Undefined for a
 * value that does not start with a description, which is every other value.
 */
function reactNativeValue(value: string | undefined): ReactNativeValue | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(', ');
  const role = REACT_NATIVE_ROLE_DESCRIPTIONS[parts[0]?.toLowerCase() ?? ''];
  if (role === undefined) return undefined;
  const states: { checked?: boolean; expanded?: boolean } = {};
  const rest: string[] = [];
  let position = 1;
  for (; position < parts.length; position += 1) {
    const word = parts[position]?.toLowerCase() ?? '';
    const state = REACT_NATIVE_STATE_WORDS[word];
    if (state !== undefined) {
      Object.assign(states, state);
      continue;
    }
    if (REACT_NATIVE_LOOSE_STATE_WORDS.has(word)) {
      rest.push(parts[position] as string);
      continue;
    }
    break;
  }
  rest.push(...parts.slice(position));
  return { role, states, value: rest.length === 0 ? undefined : rest.join(', ') };
}

/**
 * Android view classes onto the role vocabulary, keyed by the simple class
 * name in kebab case. A `TextView` is static text here where an iOS
 * `TextView` is an editor, which is why the two platforms keep separate maps.
 */
const ANDROID_ROLE_MAP: Readonly<Record<string, string>> = {
  'text-view': 'text',
  'edit-text': 'textbox',
  'auto-complete-text-view': 'textbox',
  'text-input-edit-text': 'textbox',
  'search-view': 'textbox',
  button: 'button',
  'image-button': 'button',
  'material-button': 'button',
  'image-view': 'image',
  switch: 'switch',
  'switch-compat': 'switch',
  'switch-material': 'switch',
  'toggle-button': 'switch',
  'check-box': 'checkbox',
  'material-check-box': 'checkbox',
  'radio-button': 'radio',
  'seek-bar': 'slider',
  slider: 'slider',
  spinner: 'combobox',
  'progress-bar': 'progressbar',
  'radio-group': 'radiogroup',
  'number-picker': 'spinbutton',
  toolbar: 'toolbar',
  'tab-layout': 'tablist',
  'tab-widget': 'tablist',
  'bottom-navigation-view': 'tablist',
  'tab-layout$tab-view': 'tab',
  'bottom-navigation-item-view': 'tab',
  'web-view': 'document',
  'recycler-view': 'list',
  'list-view': 'list',
  'grid-view': 'list',
  'scroll-view': 'group',
  'view-group': 'group',
  view: 'group',
  'compose-view': 'group',
  'view-factory-holder': 'group',
  'card-view': 'group',
};

/** Identifier suffixes of the view that carries an Android screen's title. */
const ANDROID_TITLE_IDS = [':id/collapsing_toolbar', ':id/action_bar', ':id/toolbar'];

/**
 * Platform element type of one raw node as a kebab-case token: XCTest sends
 * `NavigationBar` and `StaticText`, Android sends `android.widget.TextView`;
 * both read as one vocabulary here, the Android package prefix dropped.
 * `role` is the fallback some platforms send instead.
 */
function kindOf(raw: RawNode): string {
  return normalizeKind(raw.type ?? raw.role ?? '');
}

/** True when a raw type is a qualified Android class name. */
function isAndroidClass(type: string | undefined): boolean {
  return type !== undefined && type.includes('.');
}

/** One element-type spelling for `NavigationBar`, `navigation-bar`, and `android.widget.NavigationBar` alike. */
export function normalizeKind(type: string): string {
  const simple = type.slice(type.lastIndexOf('.') + 1);
  return simple
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[\s_]+/g, '-')
    .toLowerCase();
}

/** iOS containers whose button children a browser would call tabs. */
const TAB_CONTAINER_KINDS = new Set(['tab-bar', 'segmented-control']);

/**
 * Contract role for one platform element type. XCTest reports the items of a
 * tab bar or segmented control as plain buttons; the parent says what they
 * are, so a `tablist` scope finds its `tab` children as it does on the web.
 */
function roleOf(kind: string, android: boolean, parentKind: string | undefined): string | undefined {
  if (kind === '') return undefined;
  if (android) return ANDROID_ROLE_MAP[kind] ?? (kind.endsWith('layout') ? 'group' : kind);
  if (kind === 'button' && parentKind !== undefined && TAB_CONTAINER_KINDS.has(parentKind)) return 'tab';
  return ROLE_MAP[kind] ?? kind;
}

/**
 * A node the platform reports as editable takes typed text whatever its
 * class, so a custom input view, or a class the maps do not know, is a
 * `textbox` rather than its verbatim kind; a role that already takes text
 * is kept. The flag outranks a control role too: Android sets it from
 * `TextView.isTextEditable()`, so a `Button` reporting it is a text view
 * configured for input, and typed text and secrets have to reach it.
 */
function editableRole(role: string | undefined, editable: boolean | undefined): string | undefined {
  if (editable !== true) return role;
  return role !== undefined && TEXT_INPUT_ROLES.has(role) ? role : 'textbox';
}

function checkedOf(role: string | undefined, value: string | undefined): boolean | undefined {
  if (role === undefined || !CHECKABLE_ROLES.has(role) || value === undefined) return undefined;
  const lowered = value.trim().toLowerCase();
  if (CHECKED_VALUES.has(lowered)) return true;
  if (UNCHECKED_VALUES.has(lowered)) return false;
  return undefined;
}

function stripRef(ref: string | undefined): string {
  if (ref === undefined) return '';
  return ref.startsWith('@') ? ref.slice(1) : ref;
}

/**
 * Parent position of every raw node. `parentIndex` is authoritative when it
 * names a node in the list; otherwise `depth` reconstructs nesting from the
 * document order agent-device emits; a node with neither is a root.
 */
function parentPositions(raw: readonly RawNode[]): (number | undefined)[] {
  const byIndex = new Map<number, number>();
  raw.forEach((node, position) => {
    if (typeof node.index === 'number') byIndex.set(node.index, position);
  });
  const lastAtDepth: number[] = [];
  return raw.map((node, position) => {
    let parent: number | undefined;
    if (typeof node.parentIndex === 'number' && node.parentIndex >= 0) {
      const resolved = byIndex.get(node.parentIndex);
      if (resolved !== undefined && resolved < position) parent = resolved;
    }
    if (parent === undefined && typeof node.depth === 'number' && node.depth > 0) {
      parent = lastAtDepth[node.depth - 1];
    }
    if (typeof node.depth === 'number') {
      lastAtDepth[node.depth] = position;
      lastAtDepth.length = node.depth + 1;
    }
    return parent;
  });
}

/**
 * Projects one snapshot. `mintId` is called once per node in document order,
 * so the surface's id space stays unique across observations.
 */
export function projectSnapshot(raw: readonly RawNode[], options: { readonly mintId: () => string }): ProjectedSnapshot {
  const parents = parentPositions(raw);
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  parents.forEach((parent, position) => {
    if (parent === undefined) {
      roots.push(position);
      return;
    }
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [position]);
    else siblings.push(position);
  });

  const index: ProjectedNode[] = [];
  const build = (position: number, parent: ProjectedNode | undefined): SemanticNode => {
    const source = raw[position] as RawNode;
    const id = options.mintId();
    const kind = kindOf(source);
    const android = isAndroidClass(source.type);
    // The role React Native spelled into the value outranks the platform's
    // `Other`: it is the role the app declared, and iOS had no trait for it.
    // Only an `Other` carries that encoding; a native control's value is its own.
    const spelled = android || kind !== 'other' ? undefined : reactNativeValue(source.value);
    const role = editableRole(spelled?.role ?? roleOf(kind, android, parent?.kind), source.editable);
    const editable = source.editable === true || (role !== undefined && TEXT_INPUT_ROLES.has(role));
    const value = spelled === undefined ? source.value : spelled.value;
    // iOS names a secure field by class; UIAutomator flags a password
    // `EditText` by attribute, the class being the plain one.
    const secure = SECURE_KINDS.has(kind) || source.password === true;
    const checked = spelled?.states.checked ?? checkedOf(role, value);
    const states = {
      ...(source.enabled === false ? { disabled: true } : {}),
      ...(source.selected === true ? { selected: true } : {}),
      ...(source.focused === true ? { focused: true } : {}),
      ...(source.visibleToUser === false ? { hidden: true } : {}),
      ...(secure ? { secure: true } : {}),
      ...(checked === undefined ? {} : { checked }),
      ...(spelled?.states.expanded === undefined ? {} : { expanded: spelled.states.expanded }),
    };
    const identifier = source.identifier === undefined || source.identifier === '' ? undefined : source.identifier;
    const projected: { node: SemanticNode | undefined } = { node: undefined };
    const entry: ProjectedNode = {
      id,
      ref: stripRef(source.ref),
      kind,
      raw: source,
      parent,
      get node(): SemanticNode {
        return projected.node as SemanticNode;
      },
    };
    index.push(entry);
    const childNodes = (children.get(position) ?? []).map((child) => build(child, entry));
    const node: SemanticNode = {
      ref: { id, revision: '' },
      ...(role === undefined ? {} : { role }),
      // A device label is both the node's accessible name and its visible
      // text, so `toHaveText` and `getByText` read the same string; the model
      // rendering elides `text` whenever it equals `name`, so this costs nothing.
      ...(source.label === undefined || source.label === '' ? {} : { name: source.label, text: source.label }),
      // A secure field's value is never observed; the tree carries that it is
      // secure, not what it holds. Android echoes a text view's label as its
      // value, which would render every line twice, so that echo is dropped;
      // a field keeps a value equal to its label, since iOS names an
      // unlabeled field by its text and the value is what a test reads.
      ...(secure || value === undefined || value === '' || (android && !editable && value === source.label)
        ? {}
        : { value }),
      ...(secure ? { inputPurpose: 'password' as const } : {}),
      ...(Object.keys(states).length === 0 ? {} : { states }),
      // The accessibility identifier (iOS) or resource id (Android) is the node's test id.
      ...(identifier === undefined ? {} : { testId: identifier }),
      ...(source.rect === undefined ? {} : { rect: { ...source.rect } }),
      // Structural hint for tuned replay policies: an identifier survives relabeling; a label does not anchor.
      ...(identifier === undefined ? {} : { selector: `id=${quoteTerm(identifier)}` }),
      ...(childNodes.length === 0 ? {} : { children: childNodes }),
    };
    projected.node = node;
    return node;
  };
  const rootNodes = roots.map((position) => build(position, undefined));
  return { roots: rootNodes, index, viewport: viewportOf(raw) };
}

/** Quotes one selector term value the way agent-device's parser reads it back. */
function quoteTerm(value: string): string {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * The screen's logical size, read off the application or window node when
 * the platform emits one, else the extent of every rect; undefined for a
 * snapshot with no geometry at all.
 */
export function viewportOf(raw: readonly RawNode[]): ViewportSize | undefined {
  const screen = raw.find((node) => SCREEN_KINDS.has(kindOf(node)) && node.rect !== undefined);
  if (screen?.rect !== undefined && screen.rect.width > 0 && screen.rect.height > 0) {
    return { width: screen.rect.width, height: screen.rect.height };
  }
  let width = 0;
  let height = 0;
  for (const node of raw) {
    if (node.rect === undefined) continue;
    width = Math.max(width, node.rect.x + node.rect.width);
    height = Math.max(height, node.rect.y + node.rect.height);
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The id of the root node every observation is reported under. It is the
 * same across observations, as the contract requires: `perform(root, swipe)`
 * is the viewport swipe, addressed from an earlier observation.
 */
export const ROOT_ID = 'root';

/**
 * The one root the contract wants over a device's several top-level
 * elements. Its box is the viewport; it carries no name of its own, the
 * foreground app being reported as the snapshot's location.
 */
export function screenRoot(roots: readonly SemanticNode[], viewport: ViewportSize): SemanticNode {
  return {
    ref: { id: ROOT_ID, revision: '' },
    role: 'screen',
    rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    ...(roots.length === 0 ? {} : { children: roots }),
  };
}

/**
 * The visible screen's title: the navigation bar's (iOS) or toolbar's
 * (Android) own label, else the first text inside it, else its identifier
 * (UIKit names the bar after its title). Undefined when the screen has no
 * title bar, which is the honest answer for a launch screen, a full-screen
 * sheet, or Android's Settings home.
 */
export function screenTitle(snapshot: ProjectedSnapshot): string | undefined {
  const bar =
    snapshot.index.find((entry) => entry.kind === 'navigation-bar') ??
    snapshot.index.find((entry) => ANDROID_TITLE_IDS.some((suffix) => entry.raw.identifier?.endsWith(suffix) === true));
  if (bar === undefined) return undefined;
  if (bar.raw.label !== undefined && bar.raw.label.trim() !== '') return bar.raw.label;
  const text = snapshot.index.find(
    (entry) => entry.node.role === 'text' && entry.raw.label !== undefined && entry.raw.label.trim() !== '' && isWithin(entry, bar),
  );
  if (text !== undefined) return text.raw.label;
  return bar.raw.identifier === undefined || bar.raw.identifier.trim() === '' ? undefined : bar.raw.identifier;
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: ProjectedNode, ancestor: ProjectedNode): boolean {
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}
