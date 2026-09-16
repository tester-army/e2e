/**
 * Where to tap to close an on-screen keyboard that has no dismiss key.
 *
 * A phone keyboard offers no key that hides it, and the engine refuses to
 * tap around because no point outside the keyboard can be proven free of
 * side effects. What a person does is tap blank space in the scroll area
 * that holds the field, which the platform's own scroll views turn into a
 * dismissal. This module finds such a point from the tree, a spot inside the
 * focused field's scroll container, above the keyboard, with no listed node
 * under it, so the model gets a concrete candidate instead of a guess. The
 * decision to tap stays with the model: the runner only names the point.
 */

import type { ExecutorNode } from './executor.ts';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** A point that should close the keyboard, and what it lies on. */
export interface KeyboardEscapePoint {
  readonly kind: 'point';
  /** In the viewport's CSS pixels, the space `tapAt` takes. */
  readonly point: Point;
  /** The node whose blank area the point is in, for the model's prose. */
  readonly containerId: string;
}

/** Why the tree offers no such point; the model reads it, and so does whoever tunes this. */
export interface KeyboardEscapeNone {
  readonly kind: 'none';
  readonly reason: 'no-keyboard' | 'no-field' | 'no-container' | 'no-blank-space';
}

export type KeyboardEscape = KeyboardEscapePoint | KeyboardEscapeNone;

/** Roles a field's scroll container carries, innermost first. */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['scroll-view', 'list', 'group']);
const EDITABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox']);
/** Distance kept from the field, the keyboard, and the container's edges. */
const MARGIN = 24;
/** Vertical step between candidate points. */
const STEP = 16;

interface Indexed {
  readonly node: ExecutorNode;
  readonly parent: Indexed | undefined;
}

/**
 * The blank point to tap, or why the tree offers none: no keyboard listed,
 * no editable field above it, no scroll container around the field, or no
 * blank space above the keyboard inside that container.
 */
export function suggestKeyboardEscape(tree: ExecutorNode): KeyboardEscape {
  const all: Indexed[] = [];
  const walk = (node: ExecutorNode, parent: Indexed | undefined): void => {
    const entry = { node, parent };
    all.push(entry);
    for (const child of node.children ?? []) walk(child, entry);
  };
  walk(tree, undefined);

  const keyboard = all.find((entry) => entry.node.role === 'keyboard' && entry.node.rect !== undefined);
  if (keyboard === undefined) return { kind: 'none', reason: 'no-keyboard' };
  const keyboardTop = (keyboard.node.rect as Rect).y;
  // The field the keyboard serves: the focused editable when the platform
  // says which (iOS does not for every toolkit), else the editable closest
  // above the keyboard, which is where the caret is.
  const editables = all.filter((entry) => EDITABLE_ROLES.has(entry.node.role ?? '') && entry.node.rect !== undefined);
  const field =
    editables.find((entry) => entry.node.states?.focused === true) ??
    editables
      .filter((entry) => (entry.node.rect as Rect).y < keyboardTop)
      .toSorted((a, b) => (b.node.rect as Rect).y - (a.node.rect as Rect).y)[0];
  if (field === undefined) return { kind: 'none', reason: 'no-field' };
  const fieldRect = field.node.rect as Rect;

  let container: Indexed | undefined;
  for (let cursor = field.parent; cursor !== undefined; cursor = cursor.parent) {
    if (CONTAINER_ROLES.has(cursor.node.role ?? '') && cursor.node.rect !== undefined) {
      container = cursor;
      break;
    }
  }
  if (container === undefined) return { kind: 'none', reason: 'no-container' };
  const area = container.node.rect as Rect;

  // Everything that could be under a tap: listed nodes with a box, except
  // the field's own line of ancestors (the container, the layout wrappers
  // between it and the field, and everything above), and the keyboard. A
  // wrapper that spans the whole form is where blank space lives, not what
  // occupies it.
  // The keyboard's own ancestors (its window spans the whole screen) and any
  // other box that covers the whole container are layers, not content.
  const ancestors = new Set<Indexed>();
  for (let cursor: Indexed | undefined = field.parent; cursor !== undefined; cursor = cursor.parent) ancestors.add(cursor);
  for (let cursor: Indexed | undefined = keyboard.parent; cursor !== undefined; cursor = cursor.parent) ancestors.add(cursor);
  const occupied = all
    .filter((entry) => !ancestors.has(entry) && !within(entry, keyboard))
    .map((entry) => entry.node.rect)
    .filter((rect): rect is Rect => rect !== undefined && rect.width > 0 && rect.height > 0 && !covers(rect, area));

  const x = area.x + area.width / 2;
  const top = Math.max(area.y, 0) + MARGIN;
  const bottom = Math.min(area.y + area.height, keyboardTop) - MARGIN;
  // Below the field first, where the platform leaves room, then above it.
  const candidates: number[] = [];
  for (let y = fieldRect.y + fieldRect.height + MARGIN; y <= bottom; y += STEP) candidates.push(y);
  for (let y = fieldRect.y - MARGIN; y >= top; y -= STEP) candidates.push(y);
  for (const y of candidates) {
    const point = { x, y };
    if (!occupied.some((rect) => contains(rect, point))) {
      return { kind: 'point', point: { x: Math.round(x), y: Math.round(y) }, containerId: container.node.id };
    }
  }
  return { kind: 'none', reason: 'no-blank-space' };
}

function within(entry: Indexed, ancestor: Indexed): boolean {
  for (let cursor: Indexed | undefined = entry; cursor !== undefined; cursor = cursor.parent) {
    if (cursor === ancestor) return true;
  }
  return false;
}

/** True when `outer` contains every point of `inner`. */
function covers(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}
