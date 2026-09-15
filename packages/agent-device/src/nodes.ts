/**
 * Projection of an agent-device accessibility snapshot onto the contract's
 * `SemanticNode` tree. agent-device hands back a flat list with tree
 * coordinates (`index`, `parentIndex`, `depth`) and platform element types;
 * this module rebuilds the tree, maps the types onto the closed role
 * vocabulary `screen.getByRole` and trace relocation speak, and mints the
 * ids the surface owns.
 */

import type { SemanticNode } from 'e2e/engine';
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
  readonly viewport: Viewport | undefined;
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
  'menu-item': 'menuitem',
  'menu-button': 'menuitem',
  alert: 'alert',
  dialog: 'dialog',
  sheet: 'dialog',
  'action-sheet': 'dialog',
  heading: 'heading',
  header: 'heading',
  'navigation-bar': 'navigation',
  'activity-indicator': 'status',
  'progress-indicator': 'status',
};

const SECURE_KINDS = new Set(['secure-text-field', 'securetextfield', 'password-field']);
const CHECKABLE_ROLES = new Set(['switch', 'checkbox']);
const CHECKED_VALUES = new Set(['1', 'on', 'true', 'checked', 'selected']);
const UNCHECKED_VALUES = new Set(['0', 'off', 'false', 'unchecked']);
const SCREEN_KINDS = new Set(['application', 'app', 'window']);

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

/** Contract role for one platform element type. */
function roleOf(kind: string, android = false): string | undefined {
  if (kind === '') return undefined;
  if (android) return ANDROID_ROLE_MAP[kind] ?? (kind.endsWith('layout') ? 'group' : kind);
  return ROLE_MAP[kind] ?? kind;
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
    const role = roleOf(kind, isAndroidClass(source.type));
    const secure = SECURE_KINDS.has(kind);
    const checked = checkedOf(role, source.value);
    const states = {
      ...(source.enabled === false ? { disabled: true } : {}),
      ...(source.selected === true ? { selected: true } : {}),
      ...(source.focused === true ? { focused: true } : {}),
      ...(source.visibleToUser === false ? { hidden: true } : {}),
      ...(secure ? { secure: true } : {}),
      ...(checked === undefined ? {} : { checked }),
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
      // value, which would render every line twice, so an echo is dropped.
      ...(secure || source.value === undefined || source.value === '' || source.value === source.label
        ? {}
        : { value: source.value }),
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
export function viewportOf(raw: readonly RawNode[]): Viewport | undefined {
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

export type Viewport = { readonly width: number; readonly height: number };

/**
 * The one root the contract wants over a device's several top-level
 * elements. Its box is the viewport; it carries no name of its own, the
 * foreground app being reported as the snapshot's location.
 */
export function screenRoot(roots: readonly SemanticNode[], viewport: Viewport): SemanticNode {
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
