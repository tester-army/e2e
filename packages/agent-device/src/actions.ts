/** The action kinds a device surface declares. */

import type { LocatorActionKind, PointerActionKind } from 'e2e/engine';

/**
 * The action kinds a device honors, declared so the harness offers exactly
 * these: no `select` verb on a device (`selectOption`, `setInputFiles`, and
 * `scrollIntoView` have no touch equivalent), and `perform` still refuses a
 * declared kind one node cannot take (`check` on a toggle whose state is
 * unknown, `focus` on anything but a field).
 */
export const DEVICE_ACTIONS: readonly LocatorActionKind[] = [
  'tap',
  'doubleTap',
  'longPress',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'focus',
  'hover',
  'dragTo',
  'swipe',
];

/**
 * The pointer actions a device honors at a bare point: agent-device presses
 * by coordinates, so taps, double taps, and long presses land anywhere; a
 * coordinate hover, drag, secondary tap, or swipe has no touch equivalent it
 * exposes without a node.
 */
export const DEVICE_POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'longPress'];
