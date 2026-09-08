/**
 * Projection of a Cua Driver window snapshot onto the contract's
 * `SemanticNode` tree. `get_window_state` hands back a flat `elements` array
 * with tree coordinates (`element_index`, `parent_index`, `depth`), platform
 * roles (`AXButton`, UIA `Button`, AT-SPI `push button`), and frames in the
 * window's screenshot pixels; this module rebuilds the tree, maps the roles
 * onto the closed vocabulary `screen.getByRole` speaks, rebases geometry onto
 * window points, and mints the ids the surface owns.
 */

import type { SemanticNode } from '@e2edev/e2e/engine';
import type { Rect } from './support.ts';

/** A frame as Cua Driver emits it: `{x, y, w, h}` on macOS, `{x, y, width, height}` elsewhere. */
export interface RawFrame {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly width?: number;
  readonly height?: number;
}

/** The subset of one `elements[]` entry this engine reads, tolerant of per-platform field names. */
export interface RawElement {
  readonly element_index?: number;
  readonly element_token?: string;
  readonly parent_index?: number | null;
  readonly depth?: number;
  readonly role?: string;
  readonly subrole?: string;
  readonly control_type?: string;
  readonly label?: string;
  readonly name?: string;
  readonly title?: string;
  readonly value?: string | number | boolean | null;
  readonly value_state?: unknown;
  readonly description?: string;
  readonly identifier?: string;
  readonly automation_id?: string;
  readonly placeholder?: string;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly focused?: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly actions?: readonly string[];
  readonly frame?: RawFrame;
  readonly rect?: RawFrame;
  readonly bounds?: RawFrame;
}

/** The window-level facts of one snapshot the projection needs. */
export interface RawWindowState {
  readonly snapshot_id?: string;
  readonly window_bounds?: RawFrame;
  readonly screenshot_scale?: number;
  readonly screenshot_width?: number;
  readonly screenshot_height?: number;
  readonly elements?: readonly RawElement[];
  readonly degraded_reason?: string;
}

/** One projected node with what the surface needs to act on it and to answer selector terms. */
export interface ProjectedNode {
  readonly id: string;
  /** Cua Driver's per-snapshot handle; empty for a node the driver cannot act on. */
  readonly token: string;
  readonly index: number | undefined;
  /** Platform role as a kebab-case token (`button`, `secure-text-field`, `push-button`). */
  readonly kind: string;
  readonly raw: RawElement;
  readonly node: SemanticNode;
  readonly parent: ProjectedNode | undefined;
  /** Centre of the node in window screenshot pixels, the space pixel actions use. */
  readonly pixelCentre: { readonly x: number; readonly y: number } | undefined;
}

export interface ProjectedSnapshot {
  readonly snapshotId: string | undefined;
  readonly roots: readonly SemanticNode[];
  /** Every node in document order, parents before children. */
  readonly index: readonly ProjectedNode[];
  /** Window size in points; the viewport every rect refers to. */
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number } | undefined;
  /** Image pixels per point in the window screenshot. */
  readonly pixelScale: number;
  /** Window origin on the desktop, in points. */
  readonly windowOrigin: { readonly x: number; readonly y: number } | undefined;
}

/**
 * Platform roles onto the role vocabulary. macOS AX roles arrive as
 * `AXButton`, UIA control types as `Button`, AT-SPI roles as `push button`;
 * `normalizeKind` folds all three into one kebab-case token before the
 * lookup. Anything not listed keeps its token as the role, so no
 * information is lost; the map only makes the common controls answer the
 * same `getByRole` a browser does.
 */
const ROLE_MAP: Readonly<Record<string, string>> = {
  // buttons
  button: 'button',
  'push-button': 'button',
  'menu-button': 'button',
  'popup-button': 'combobox',
  'pop-up-button': 'combobox',
  'split-button': 'button',
  'disclosure-triangle': 'button',
  'toggle-button': 'switch',
  switch: 'switch',
  toggle: 'switch',
  // text
  'text-field': 'textbox',
  'secure-text-field': 'textbox',
  'text-area': 'textbox',
  'search-field': 'textbox',
  edit: 'textbox',
  entry: 'textbox',
  'password-text': 'textbox',
  document: 'document',
  'web-area': 'document',
  'static-text': 'text',
  text: 'text',
  label: 'text',
  // choices
  'check-box': 'checkbox',
  checkbox: 'checkbox',
  'radio-button': 'radio',
  'radio-group': 'radiogroup',
  'combo-box': 'combobox',
  combobox: 'combobox',
  slider: 'slider',
  incrementor: 'spinbutton',
  spinner: 'spinbutton',
  'spin-button': 'spinbutton',
  'value-indicator': 'status',
  'progress-indicator': 'progressbar',
  'progress-bar': 'progressbar',
  'busy-indicator': 'status',
  'status-bar': 'status',
  // navigation and structure
  link: 'link',
  hyperlink: 'link',
  image: 'image',
  list: 'list',
  'list-item': 'listitem',
  outline: 'tree',
  tree: 'tree',
  'tree-item': 'treeitem',
  'outline-row': 'treeitem',
  table: 'table',
  'data-grid': 'table',
  row: 'row',
  'table-row': 'row',
  'data-item': 'row',
  cell: 'cell',
  'table-cell': 'cell',
  column: 'group',
  'tab-group': 'tablist',
  tab: 'tab',
  'tab-item': 'tab',
  'page-tab': 'tab',
  'page-tab-list': 'tablist',
  'menu-bar': 'menubar',
  menu: 'menu',
  'menu-item': 'menuitem',
  'menu-bar-item': 'menuitem',
  'check-menu-item': 'menuitemcheckbox',
  'radio-menu-item': 'menuitemradio',
  toolbar: 'toolbar',
  'tool-bar': 'toolbar',
  heading: 'heading',
  header: 'heading',
  'header-item': 'columnheader',
  window: 'window',
  sheet: 'dialog',
  dialog: 'dialog',
  drawer: 'group',
  pane: 'group',
  group: 'group',
  'scroll-area': 'group',
  'scroll-pane': 'group',
  'split-group': 'group',
  'split-pane': 'group',
  'layout-area': 'group',
  panel: 'group',
  filler: 'group',
  custom: 'group',
  generic: 'group',
  'scroll-bar': 'scrollbar',
  separator: 'separator',
  'tool-tip': 'tooltip',
  tooltip: 'tooltip',
  'title-bar': 'group',
  application: 'application',
  frame: 'window',
  unknown: 'group',
};

/** Roles whose `value` reports a checked state rather than content. */
const CHECKABLE_ROLES = new Set(['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio']);
const CHECKED_VALUES = new Set(['1', 'on', 'true', 'checked', 'selected', 'mixed']);
const UNCHECKED_VALUES = new Set(['0', 'off', 'false', 'unchecked']);
/** Roles whose value is a credential the tree must never carry. */
const SECURE_KINDS = new Set(['secure-text-field', 'password-text', 'password-field']);
const SECURE_SUBROLES = new Set(['secure-text-field', 'password-field']);

/**
 * One platform role spelling for `AXButton`, `Button`, `push button`, and
 * `push_button` alike: the `AX` prefix dropped, camel case split, spaces and
 * underscores folded, lower-cased.
 */
export function normalizeKind(role: string): string {
  const stripped = role.startsWith('AX') ? role.slice(2) : role;
  return stripped
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[\s_]+/g, '-')
    .toLowerCase();
}

function kindOf(raw: RawElement): string {
  return normalizeKind(raw.role ?? raw.control_type ?? '');
}

function roleOf(kind: string): string | undefined {
  if (kind === '') return undefined;
  return ROLE_MAP[kind] ?? kind;
}

function textOf(value: RawElement['value']): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}

function checkedOf(role: string | undefined, raw: RawElement): boolean | undefined {
  if (raw.checked !== undefined) return raw.checked;
  if (role === undefined || !CHECKABLE_ROLES.has(role)) return undefined;
  const value = textOf(raw.value) ?? (typeof raw.value_state === 'object' && raw.value_state !== null ? undefined : textOf(raw.value_state as RawElement['value']));
  if (value === undefined) return undefined;
  const lowered = value.trim().toLowerCase();
  if (CHECKED_VALUES.has(lowered)) return true;
  if (UNCHECKED_VALUES.has(lowered)) return false;
  return undefined;
}

function frameOf(raw: RawElement): Rect | undefined {
  const frame = raw.frame ?? raw.rect ?? raw.bounds;
  if (frame === undefined) return undefined;
  const width = frame.w ?? frame.width;
  const height = frame.h ?? frame.height;
  if (frame.x === undefined || frame.y === undefined || width === undefined || height === undefined) return undefined;
  return { x: frame.x, y: frame.y, width, height };
}

function rectOf(frame: RawFrame | undefined): Rect | undefined {
  if (frame === undefined) return undefined;
  const width = frame.w ?? frame.width;
  const height = frame.h ?? frame.height;
  if (frame.x === undefined || frame.y === undefined || width === undefined || height === undefined) return undefined;
  return { x: frame.x, y: frame.y, width, height };
}

/**
 * Parent position of every raw element. `parent_index` is authoritative when
 * it names an element in the list; otherwise `depth` reconstructs nesting
 * from the document order the driver emits; an element with neither is a root.
 */
function parentPositions(raw: readonly RawElement[]): (number | undefined)[] {
  const byIndex = new Map<number, number>();
  raw.forEach((element, position) => {
    if (typeof element.element_index === 'number') byIndex.set(element.element_index, position);
  });
  const lastAtDepth: number[] = [];
  return raw.map((element, position) => {
    let parent: number | undefined;
    if (typeof element.parent_index === 'number' && element.parent_index >= 0) {
      const resolved = byIndex.get(element.parent_index);
      if (resolved !== undefined && resolved < position) parent = resolved;
    }
    if (parent === undefined && typeof element.depth === 'number' && element.depth > 0) {
      parent = lastAtDepth[element.depth - 1];
    }
    if (typeof element.depth === 'number') {
      lastAtDepth[element.depth] = position;
      lastAtDepth.length = element.depth + 1;
    }
    return parent;
  });
}

/**
 * Projects one window snapshot. `mintId` is called once per element in
 * document order, so the surface's id space stays unique across observations.
 */
export function projectSnapshot(
  state: RawWindowState,
  options: { readonly testIdAttribute: string; readonly mintId: () => string },
): ProjectedSnapshot {
  const raw = state.elements ?? [];
  const window = rectOf(state.window_bounds);
  const scale = state.screenshot_scale !== undefined && state.screenshot_scale > 0 ? state.screenshot_scale : 1;
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
    const source = raw[position] as RawElement;
    const id = options.mintId();
    const kind = kindOf(source);
    const role = roleOf(kind);
    const secure =
      SECURE_KINDS.has(kind) || (source.subrole !== undefined && SECURE_SUBROLES.has(normalizeKind(source.subrole)));
    const checked = checkedOf(role, source);
    // Frames arrive in window screenshot pixels, the space pixel actions use.
    const pixels = frameOf(source);
    const rect =
      pixels === undefined
        ? undefined
        : { x: pixels.x / scale, y: pixels.y / scale, width: pixels.width / scale, height: pixels.height / scale };
    const hidden = pixels !== undefined && (pixels.width <= 0 || pixels.height <= 0);
    const states = {
      ...(source.enabled === false ? { disabled: true } : {}),
      ...(source.selected === true ? { selected: true } : {}),
      ...(source.focused === true ? { focused: true } : {}),
      ...(source.expanded === true ? { expanded: true } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(secure ? { secure: true } : {}),
      ...(checked === undefined ? {} : { checked }),
    };
    const label = firstText(source.label, source.name, source.title);
    const identifier = firstText(source.identifier, source.automation_id);
    const value = secure ? undefined : textOf(source.value);
    const projected: { node: SemanticNode | undefined } = { node: undefined };
    const entry: ProjectedNode = {
      id,
      token: source.element_token ?? '',
      index: source.element_index,
      kind,
      raw: source,
      parent,
      pixelCentre: pixels === undefined ? undefined : { x: pixels.x + pixels.width / 2, y: pixels.y + pixels.height / 2 },
      get node(): SemanticNode {
        return projected.node as SemanticNode;
      },
    };
    index.push(entry);
    const childNodes = (children.get(position) ?? []).map((child) => build(child, entry));
    const attributes = {
      ...(identifier === undefined ? {} : { [options.testIdAttribute]: identifier }),
      ...(source.placeholder === undefined || source.placeholder === '' ? {} : { placeholder: source.placeholder }),
      ...(source.description === undefined || source.description === '' || source.description === label
        ? {}
        : { description: source.description }),
    };
    const node: SemanticNode = {
      ref: { id, revision: '' },
      ...(role === undefined ? {} : { role }),
      // A label is both the node's accessible name and its visible text, so
      // `toHaveText` and `getByText` read the same string; the model rendering
      // elides `text` whenever it equals `name`, so this costs nothing.
      ...(label === undefined ? {} : { name: label, text: label }),
      // A secure field's value is never observed; the tree carries that it is
      // secure, not what it holds. A value that echoes the label would render
      // every line twice, so an echo is dropped.
      ...(value === undefined || value === label || (checked !== undefined && CHECKABLE_ROLES.has(role ?? ''))
        ? {}
        : { value }),
      ...(secure ? { inputPurpose: 'password' as const } : {}),
      ...(Object.keys(states).length === 0 ? {} : { states }),
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
      ...(rect === undefined ? {} : { rect }),
      // Structural hint for tuned replay policies: an identifier survives relabeling; a label does not anchor.
      ...(identifier === undefined ? {} : { selector: `id=${quoteTerm(identifier)}` }),
      ...(childNodes.length === 0 ? {} : { children: childNodes }),
    };
    projected.node = node;
    return node;
  };
  const rootNodes = roots.map((position) => build(position, undefined));
  return {
    snapshotId: state.snapshot_id,
    roots: rootNodes,
    index,
    viewport: window === undefined ? undefined : { width: window.width, height: window.height, scale: 1 },
    pixelScale: scale,
    windowOrigin: window === undefined ? undefined : { x: window.x, y: window.y },
  };
}

function firstText(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/** Quotes one selector term value the way this engine's selector parser reads it back. */
export function quoteTerm(value: string): string {
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: ProjectedNode, ancestor: ProjectedNode): boolean {
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}
