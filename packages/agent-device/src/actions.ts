/** The action kinds a device surface declares, and the pointer dispatch that agrees with them. */

import type { LocatorActionKind, PointerAction, PointerActionKind, ViewportPoint } from 'e2e/engine';
import type { AgentDeviceClient } from './options.ts';
import { unsupported } from './support.ts';

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

/**
 * Issues one pointer action at a screen point in logical pixels. `settle` is
 * the device's quiet-wait options, spread onto the interaction as the node
 * actions do. The kinds outside `DEVICE_POINTER_ACTIONS` never arrive: the
 * harness routes only declared kinds. They are refused here so the switch
 * stays exhaustive against the contract.
 */
export function pointerInteraction(
  client: AgentDeviceClient,
  point: ViewportPoint,
  action: PointerAction,
  settle: Record<string, unknown>,
): Promise<unknown> {
  const at = { x: point.x, y: point.y };
  switch (action.kind) {
    case 'tap':
      return client.interactions.press({ ...at, ...settle });
    case 'doubleTap':
      return client.interactions.press({ ...at, doubleTap: true, ...settle });
    case 'longPress':
      return client.interactions.longPress({
        ...at,
        ...settle,
        ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
      });
    case 'secondaryTap':
    case 'hover':
    case 'dragTo':
    case 'swipe':
      throw unsupported(`agent-device cannot perform "${action.kind}" at a bare point`);
  }
}
