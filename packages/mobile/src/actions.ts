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
/**
 * How long a `longPress` holds when the caller names no duration: the agent's
 * `long_press` tool and a test's bare `longPress()`. agent-device's own
 * default is under half a second, shorter than a React Native `Pressable`'s
 * `delayLongPress` of 500 ms, let alone the longer thresholds apps set, so a
 * default hold there registers as a tap. One second clears them the way
 * Detox's default does; a test that needs more passes `duration`.
 */
export const DEFAULT_LONG_PRESS_MS = 1_000;

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
 * actions do. A double tap is two presses (`count: 2`), as it is on a node:
 * agent-device's own double-tap gesture reaches a React Native `Pressable`
 * on iOS as one press, while two presses in a row land about 285 ms apart.
 * The kinds outside `DEVICE_POINTER_ACTIONS` never arrive: the harness
 * routes only declared kinds. They are refused here so the switch stays
 * exhaustive against the contract.
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
      return client.interactions.press({ ...at, count: 2, ...settle });
    case 'longPress':
      return client.interactions.longPress({ ...at, ...settle, durationMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
    case 'swipeTo':
      return client.interactions.swipe({ from: at, to: { x: action.target.x, y: action.target.y } });
    case 'secondaryTap':
    case 'hover':
    case 'dragTo':
    case 'swipe':
      throw unsupported(`agent-device cannot perform "${action.kind}" at a bare point`);
  }
}
