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
 * and swipes by coordinates, so taps, double taps, long presses, and a swipe
 * to another point land anywhere. A coordinate hover, secondary tap, or drag
 * (a hold before the move, unlike a swipe) has no touch equivalent it exposes
 * without a node, and a directional swipe at a bare point has no length, so
 * only the screen root scrolls that way.
 */
export const DEVICE_POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'longPress', 'swipeTo'];

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
    case 'swipeTo':
      return client.interactions.swipe({ from: at, to: { x: action.target.x, y: action.target.y } });
    case 'secondaryTap':
    case 'hover':
    case 'dragTo':
    case 'swipe':
      throw unsupported(`agent-device cannot perform "${action.kind}" at a bare point`);
  }
}
