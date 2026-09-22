/** The role sets the runner reads a node against: what takes typed text, what carries a value. */

import type { SemanticNode } from '../engine/surface.ts';

/** Roles that take typed text: what a secret may fill and what an on-screen keyboard serves. */
const EDITABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * Roles whose node carries a `value`: the editable roles plus the controls a
 * platform reports a value for without taking typed text (a range input, a
 * number stepper, a multiple select and its options).
 */
const VALUE_ROLES: ReadonlySet<string> = new Set([...EDITABLE_ROLES, 'spinbutton', 'slider', 'listbox', 'option']);

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
