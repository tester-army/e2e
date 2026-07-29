/**
 * Platform role normalization for `mobile-0.1`. The tables here are the
 * normative ones in spec/16-mobile.md; changing a mapping is a specification
 * change, not an implementation detail.
 *
 * `getByRole` uses WAI-ARIA 1.2 role names on every platform, so both tables
 * target that vocabulary. An element type absent from its platform's table
 * normalizes to `generic`.
 */

/** The ARIA role names `mobile-0.1` projects onto. */
export type MobileRole =
  | 'application'
  | 'alertdialog'
  | 'banner'
  | 'button'
  | 'checkbox'
  | 'combobox'
  | 'document'
  | 'generic'
  | 'img'
  | 'link'
  | 'list'
  | 'listitem'
  | 'menu'
  | 'menuitem'
  | 'navigation'
  | 'paragraph'
  | 'progressbar'
  | 'radio'
  | 'searchbox'
  | 'slider'
  | 'spinbutton'
  | 'switch'
  | 'tab'
  | 'tablist'
  | 'textbox'
  | 'toolbar';

export type MobilePlatform = 'ios' | 'android';

/**
 * Reduces a platform role, subrole, or native type to a comparison key:
 * lowercase, `XCUIElementType`/package prefixes removed, and camelCase or
 * snake_case folded to kebab-case. It lets one table entry match both the
 * backend's normalized name and the raw platform type.
 */
export function roleKey(value: string): string {
  const withoutPackage = value.includes('.') ? (value.split('.').pop() ?? value) : value;
  return withoutPackage
    .replace(/^XCUIElementType/i, '')
    .replace(/[_\s]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

const IOS_ROLES: ReadonlyMap<string, MobileRole> = new Map([
  ['button', 'button'],
  ['key', 'button'],
  ['link', 'link'],
  ['static-text', 'paragraph'],
  ['text', 'paragraph'],
  ['text-field', 'textbox'],
  ['text-view', 'textbox'],
  ['secure-text-field', 'textbox'],
  ['search-field', 'searchbox'],
  ['check-box', 'checkbox'],
  ['radio-button', 'radio'],
  ['switch', 'switch'],
  ['toggle', 'switch'],
  ['slider', 'slider'],
  ['stepper', 'spinbutton'],
  ['image', 'img'],
  ['cell', 'listitem'],
  ['table', 'list'],
  ['collection-view', 'list'],
  ['navigation-bar', 'navigation'],
  ['tab-bar', 'tablist'],
  ['segmented-control', 'tablist'],
  ['tab', 'tab'],
  ['alert', 'alertdialog'],
  ['sheet', 'alertdialog'],
  ['activity-indicator', 'progressbar'],
  ['progress-indicator', 'progressbar'],
  ['toolbar', 'toolbar'],
  ['picker', 'combobox'],
  ['picker-wheel', 'combobox'],
  ['menu', 'menu'],
  ['menu-item', 'menuitem'],
  ['menu-button', 'button'],
  ['status-bar', 'banner'],
  ['web-view', 'document'],
  ['application', 'application'],
  ['window', 'generic'],
  ['other', 'generic'],
  ['keyboard', 'generic'],
]);

const ANDROID_ROLES: ReadonlyMap<string, MobileRole> = new Map([
  ['button', 'button'],
  ['image-button', 'button'],
  ['app-compat-button', 'button'],
  ['material-button', 'button'],
  ['text-view', 'paragraph'],
  ['app-compat-text-view', 'paragraph'],
  ['edit-text', 'textbox'],
  ['app-compat-edit-text', 'textbox'],
  ['text-input-edit-text', 'textbox'],
  ['search-view', 'searchbox'],
  ['search-bar', 'searchbox'],
  ['check-box', 'checkbox'],
  ['app-compat-check-box', 'checkbox'],
  ['material-check-box', 'checkbox'],
  ['checkbox', 'checkbox'],
  ['radio-button', 'radio'],
  ['app-compat-radio-button', 'radio'],
  ['switch', 'switch'],
  ['switch-compat', 'switch'],
  ['switch-material', 'switch'],
  ['material-switch', 'switch'],
  ['toggle-button', 'switch'],
  ['seek-bar', 'slider'],
  ['rating-bar', 'slider'],
  ['slider', 'slider'],
  ['progress-bar', 'progressbar'],
  ['content-loading-progress-bar', 'progressbar'],
  ['image-view', 'img'],
  ['app-compat-image-view', 'img'],
  ['image', 'img'],
  ['recycler-view', 'list'],
  ['list-view', 'list'],
  ['grid-view', 'list'],
  ['expandable-list-view', 'list'],
  ['spinner', 'combobox'],
  ['app-compat-spinner', 'combobox'],
  ['dropdown-list', 'combobox'],
  ['auto-complete-text-view', 'combobox'],
  ['tab-widget', 'tablist'],
  ['tab-layout', 'tablist'],
  ['tab-view', 'tab'],
  ['tab-item', 'tab'],
  ['tab', 'tab'],
  ['toolbar', 'toolbar'],
  ['action-bar', 'toolbar'],
  ['material-toolbar', 'toolbar'],
  ['alert-dialog', 'alertdialog'],
  ['alert-dialog-layout', 'alertdialog'],
  ['web-view', 'document'],
]);

/** Native types whose content scrolls. `scrollUntilVisible` targets these. */
const SCROLL_CONTAINERS: ReadonlySet<string> = new Set([
  'scroll-view',
  'horizontal-scroll-view',
  'nested-scroll-view',
  'recycler-view',
  'list-view',
  'grid-view',
  'expandable-list-view',
  'view-pager',
  'view-pager2',
  'table',
  'collection-view',
  'table-view',
]);

/** The `checkable` roles for which `mobile-0.1` derives a `checked` state. */
const CHECKABLE_ROLES: ReadonlySet<MobileRole> = new Set(['checkbox', 'radio', 'switch']);

/** Node fields the role tables read, in precedence order. */
export interface RoleSource {
  readonly role?: string | undefined;
  readonly subrole?: string | undefined;
  readonly type?: string | undefined;
}

/**
 * Normalizes one node to its ARIA role. Precedence is role, subrole, then
 * native type, first match wins; an unmapped type is `generic`.
 *
 * `checkable` covers the Android `CheckedTextView` split, where the same class
 * is a checkbox when it exposes a checkable state and static text otherwise.
 * `parentRole` supplies the Android rule that a direct child of a `list` is a
 * `listitem`.
 */
export function normalizeRole(
  node: RoleSource,
  platform: MobilePlatform,
  options: { readonly checkable?: boolean; readonly parentRole?: MobileRole } = {},
): MobileRole {
  const table = platform === 'ios' ? IOS_ROLES : ANDROID_ROLES;
  for (const candidate of [node.role, node.subrole, node.type]) {
    if (candidate === undefined || candidate === '') continue;
    const key = roleKey(candidate);
    if (platform === 'android' && key === 'checked-text-view') {
      return options.checkable === true ? 'checkbox' : 'paragraph';
    }
    const mapped = table.get(key);
    if (mapped !== undefined) return mapped;
  }
  if (platform === 'android' && options.parentRole === 'list') return 'listitem';
  return 'generic';
}

/** Reports whether a node's content scrolls, from its native type. */
export function isScrollContainer(node: RoleSource): boolean {
  for (const candidate of [node.role, node.subrole, node.type]) {
    if (candidate === undefined || candidate === '') continue;
    if (SCROLL_CONTAINERS.has(roleKey(candidate))) return true;
  }
  return false;
}

/** Reports whether `mobile-0.1` derives a `checked` state for this role. */
export function isCheckableRole(role: MobileRole): boolean {
  return CHECKABLE_ROLES.has(role);
}

const CHECKED_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'checked', 'on']);
const UNCHECKED_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'unchecked', 'off']);

/**
 * Derives the `checked` state per spec/16-mobile.md. It returns undefined when
 * the state is unavailable, which never matches a query, rather than guessing.
 */
export function deriveChecked(
  role: MobileRole,
  value: string | undefined,
  selected: boolean | undefined,
): boolean | undefined {
  if (!isCheckableRole(role)) return undefined;
  if (value !== undefined) {
    const normalized = value.trim().toLowerCase();
    if (CHECKED_VALUES.has(normalized)) return true;
    if (UNCHECKED_VALUES.has(normalized)) return false;
    return undefined;
  }
  return selected;
}
