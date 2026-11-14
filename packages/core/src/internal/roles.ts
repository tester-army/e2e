/** The role sets the runner reads a node against: what takes typed text, what carries a value, what has a checked state. */

import type { SemanticNode } from '../engine/surface.ts';

/** Roles that take typed text: what a secret may fill and what an on-screen keyboard serves. */
const EDITABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * Roles whose node carries a `value`: the editable roles plus the controls a
 * platform reports a value for without taking typed text (a range input, a
 * number stepper, a multiple select and its options).
 */
const VALUE_ROLES: ReadonlySet<string> = new Set([...EDITABLE_ROLES, 'spinbutton', 'slider', 'listbox', 'option']);

/** Roles with a checked state, the ARIA roles that take `aria-checked`, as Playwright lists them. */
const CHECKED_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'menuitemcheckbox',
  'option',
  'radio',
  'switch',
  'menuitemradio',
  'treeitem',
]);

/** True for a node of an editable role. */
export function isEditable(node: Pick<SemanticNode, 'role'>): boolean {
  return EDITABLE_ROLES.has(node.role ?? '');
}

/**
 * True for a node whose role carries a value, whether or not the platform
 * reported one: a device engine omits an empty value, so an empty field is
 * told apart from a heading, which has no value at all, by its role.
 */
export function isValueControl(node: Pick<SemanticNode, 'role'>): boolean {
  return VALUE_ROLES.has(node.role ?? '');
}

/**
 * True for a node that has a checked state: one the platform reported, or a
 * role that carries one, since a node of that role with no state reported is
 * unchecked. A button or a heading has none.
 */
export function isCheckable(node: Pick<SemanticNode, 'role' | 'states'>): boolean {
  return node.states?.checked !== undefined || CHECKED_ROLES.has(node.role ?? '');
}
