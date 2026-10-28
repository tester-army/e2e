/** Where the keyboard-dismissing drag may start on a screen without pressing anything. */

import type { ViewportSize } from 'e2e/engine';
import { SCREEN_KINDS, type ProjectedSnapshot } from './nodes.ts';
import type { Point, Rect } from './support.ts';

/**
 * Roles no drag starts on, whether or not their children are listed: the
 * ones a touch presses, toggles, or focuses, and the bars, where a drag
 * never reaches the content.
 */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'slider',
  'spinbutton',
  'listitem',
  'navigation',
  'toolbar',
  'tablist',
]);

/** Platform kinds that scroll, so a short drag on them reads as the touch that sends the keyboard away. */
const SCROLL_KINDS: ReadonlySet<string> = new Set(['scroll-view', 'table', 'collection-view', 'recycler-view', 'list-view']);

/** Roles a touch does nothing to: a leaf with one of these is content, not a control. */
const STATIC_ROLES: ReadonlySet<string> = new Set(['text', 'image', 'heading', 'status', 'progressbar']);

/**
 * How far a drag starts from any control, in points: a control's touch area
 * runs past its frame (React Native's `hitSlop`, UIKit's own padding), and
 * the drag's first few points are inside touch slop, where it still counts
 * as a tap on whatever it started on.
 */
const CONTROL_CLEARANCE = 8;

/**
 * The share of the screen a leaf covers past which it is content merged into
 * one element (a flattened tree), not a control: the tree shows nothing
 * inside it to steer clear of.
 */
const MERGED_SHARE = 0.5;

/** The share of each screen edge no drag starts in: the status bar, the home indicator, and the system edge gestures live there. */
const EDGE_SHARE = 0.1;

/** How many candidate points the search lays across the screen's shorter side. */
const GRID_STEPS = 40;

/**
 * Where a keyboard-dismissing drag starts: the point nearest the middle of
 * the screen that is above the keyboard and clear of every control. When the
 * screen has a scroll view the point must be inside one, since a scroll view
 * is what turns the drag into a dismissal and a drag anywhere else does
 * nothing. A control is a node a touch acts on: one with a control role, or
 * a leaf that is not plain content (text, an image), since a React Native
 * `Pressable` with no role is an unnamed leaf like any other. A `Text` with
 * its own `onPress` reads as plain text and is one this misses; a control
 * inside a flattened tree, which shows as one leaf over most of the screen,
 * is the other.
 * Undefined when no point qualifies: a drag there would press a control or
 * do nothing.
 */
export function keyboardDragStart(projected: ProjectedSnapshot, viewport: ViewportSize, keyboardTop: number): Point | undefined {
  const controls: Rect[] = [];
  const scrollViews: Rect[] = [];
  const merged = viewport.width * viewport.height * MERGED_SHARE;
  for (const entry of projected.index) {
    const { rect, role, children, states } = entry.node;
    if (rect === undefined || states?.hidden === true || SCREEN_KINDS.has(entry.kind)) continue;
    if (SCROLL_KINDS.has(entry.kind)) scrollViews.push(rect);
    else if ((role !== undefined && CONTROL_ROLES.has(role)) || (children === undefined && !STATIC_ROLES.has(role ?? '') && rect.width * rect.height <= merged)) {
      controls.push(grow(rect, CONTROL_CLEARANCE));
    }
  }
  const left = viewport.width * EDGE_SHARE;
  const right = viewport.width * (1 - EDGE_SHARE);
  const top = viewport.height * EDGE_SHARE;
  const bottom = Math.min(viewport.height * (1 - EDGE_SHARE), keyboardTop - CONTROL_CLEARANCE);
  const centre = { x: viewport.width / 2, y: viewport.height / 2 };
  // The grid is anchored on the centre, so a screen with nothing there starts where a user's thumb would.
  const step = Math.min(viewport.width, viewport.height) / GRID_STEPS;
  let best: { point: Point; distance: number } | undefined;
  for (let y = centre.y - Math.floor((centre.y - top) / step) * step; y <= bottom; y += step) {
    for (let x = centre.x - Math.floor((centre.x - left) / step) * step; x <= right; x += step) {
      const point = { x, y };
      if (scrollViews.length > 0 && !scrollViews.some((view) => contains(view, point))) continue;
      if (controls.some((control) => contains(control, point))) continue;
      const distance = Math.hypot(x - centre.x, y - centre.y);
      if (best === undefined || distance < best.distance) best = { point, distance };
    }
  }
  return best?.point;
}

/** A rect grown by `margin` on every side. */
function grow(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

/** Whether a point lies inside a rect, edges included. */
function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
