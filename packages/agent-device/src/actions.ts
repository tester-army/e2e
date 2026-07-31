/**
 * Maps `LocatorAction` onto agent-device interactions, and owns the mobile
 * actionability rules of spec/16-mobile.md.
 *
 * Every mutator here is split into a precommit phase and a dispatch phase. A
 * precommit failure is retryable or `NOT_ACTIONABLE`; once dispatch starts,
 * failure is `ACTION_MAY_HAVE_COMMITTED` and the runner will not repeat it.
 */

import {
  DriverError,
  type LocatorAction,
  type Momentum,
  type OperationContext,
  type ScrollDirection,
} from 'e2e/driver';
import type { AgentDeviceClient } from './client.ts';
import { keyToText } from './keys.ts';
import { clientRef, controlOf, nearestScrollContainer, type ProjectedNode } from './snapshot.ts';
import { momentumGesture, rectCenter, swipePath, unsupported, withDeadline } from './support.ts';

/**
 * Waiting for the UI to go quiet after a mutation.
 *
 * A mobile transition animates for a few hundred milliseconds, so a snapshot
 * taken straight after a tap can capture the previous screen. Assertions poll
 * and would recover, but a direct read does not: it would return the old screen
 * and report success. The backend can fold this wait into the action's own round
 * trip, which costs nothing extra when the UI is already still.
 */
const SETTLE: { readonly settle: true; readonly settleQuietMs: number; readonly timeoutMs: number } =
  { settle: true, settleQuietMs: 250, timeoutMs: 5_000 };

/**
 * Waits for the screen to stop moving.
 *
 * `spec/16-mobile.md` requires the UI to be quiet after a mutation before the
 * next observation. Input commands carry a `settle` flag that does this, but
 * the gesture commands do not accept one, and iOS scrolling has inertia: the
 * list keeps travelling after the gesture returns. A snapshot taken then
 * reports geometry that is already wrong, and an action dispatched against it
 * lands on whatever slid into that position — observed as a tap that hit the
 * row above the one the test asked for.
 *
 * Failure to settle is not fatal: the caller re-resolves anyway, so a backend
 * that cannot answer this leaves behaviour exactly as it was.
 */
async function settleAfterGesture(
  client: AgentDeviceClient,
  scope: InteractionScope,
  operation: OperationContext,
): Promise<void> {
  await withDeadline(
    client.command
      .wait({ platform: scope.platform, stable: true, quietMs: 250, timeoutMs: 5_000 })
      .catch(() => undefined),
    operation,
    'settle',
  );
}

/**
 * Resolves one key to the text that presses it, failing loudly when the platform
 * cannot express it. Typing the key's name instead would insert the word
 * "Enter" into a field and report success.
 */
export function requireKeyText(key: string, platform: 'ios' | 'android'): string {
  const text = keyToText(key, platform);
  if (text === undefined) {
    throw unsupported(`the key "${key}" on ${platform}; no keyboard encoding exists for it`);
  }
  return text;
}

/**
 * The platform delete key. Both backends interpret it inside typed text, which
 * is the only way to empty a field: there is no clear command and empty fill
 * text is rejected.
 */
const DELETE_KEY = '\u0008';

/** Selection fields every interaction carries so the daemon targets one device. */
export interface InteractionScope {
  readonly platform: 'ios' | 'android';
  /** Device viewport in points, when a snapshot has revealed it. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

/**
 * Asserts a resolved node can receive the requested input. `mobile-0.1`
 * forbids retargeting: a node that is not itself hit testable fails rather than
 * substituting an ancestor.
 */
export function assertActionable(
  node: ProjectedNode,
  action: LocatorAction['kind'],
): void {
  if (!node.visible) {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} is not visible`, {
      retryable: false,
    });
  }
  if (node.covered) {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} is covered by another element`, {
      retryable: false,
    });
  }
  // `scrollIntoView` is how a test brings an off-screen node into the viewport,
  // so it is the one action that may target a node outside it.
  if (!node.withinViewport && action !== 'scrollIntoView') {
    throw new DriverError(
      'NOT_ACTIONABLE',
      `node ${node.ref} is outside the viewport; scroll it into view first`,
      { retryable: false },
    );
  }
  if (!node.enabled) {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} is disabled`, { retryable: false });
  }
  if ((action === 'fill' || action === 'clear') && !node.editable) {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} is not editable`, {
      retryable: false,
    });
  }
}

/** The rect an action dispatches against, or a failure when geometry is absent. */
export function requireRect(node: ProjectedNode): NonNullable<ProjectedNode['rect']> {
  if (node.rect === undefined) {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} has no geometry`, {
      retryable: false,
    });
  }
  return node.rect;
}

/**
 * Performs one locator action against a resolved node.
 *
 * The caller has already checked actionability, so every await here is in the
 * committed phase and its failures are translated as such.
 */
export async function performAction(
  client: AgentDeviceClient,
  scope: InteractionScope,
  node: ProjectedNode,
  action: LocatorAction,
  operation: OperationContext,
): Promise<void> {
  // Dispatch against the node input actually reaches, which for a nested
  // control is an inner node of the selected one rather than its wrapper.
  const control = controlOf(node);
  const base = { platform: scope.platform, ref: clientRef(control) } as const;
  switch (action.kind) {
    case 'tap':
      await withDeadline(client.interactions.click({ ...base, ...SETTLE }), operation, 'tap');
      return;
    case 'doubleTap':
      await withDeadline(
        client.interactions.click({ ...base, doubleTap: true, ...SETTLE }),
        operation,
        'doubleTap',
      );
      return;
    case 'longPress':
      await withDeadline(
        client.interactions.longPress({
          ...base,
          ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
          ...SETTLE,
        }),
        operation,
        'longPress',
      );
      return;
    case 'fill': {
      const options = { ...base, text: action.value, ...SETTLE };
      // oxlint-disable-next-line no-array-fill-with-reference-type -- this is the daemon's fill command, not Array#fill
      await withDeadline(client.interactions.fill(options), operation, 'fill');
      return;
    }
    case 'clear': {
      // The backend has no clear command and rejects empty fill text, so
      // clearing is one delete key per character. Focus first, because typing
      // goes to the focused field.
      if (control.valueLength === 0) return;
      await withDeadline(
        client.interactions.focus(pointOf(scope, control)),
        operation,
        'clear',
      );
      await withDeadline(
        client.interactions.type({
          platform: scope.platform,
          text: DELETE_KEY.repeat(control.valueLength),
        }),
        operation,
        'clear',
      );
      return;
    }
    case 'focus':
      await withDeadline(client.interactions.focus(pointOf(scope, control)), operation, 'focus');
      return;
    case 'press': {
      // Resolve the encoding before anything is dispatched, so an unsupported
      // key fails without having touched the device.
      const text = requireKeyText(action.key, scope.platform);
      // A key press targets the focused field, so focus the node first.
      await withDeadline(client.interactions.focus(pointOf(scope, control)), operation, 'press');
      await withDeadline(
        client.interactions.type({ platform: scope.platform, text }),
        operation,
        'press',
      );
      return;
    }
    case 'check':
    case 'uncheck': {
      const wanted = action.kind === 'check';
      // Toggling an already-correct control would invert it, so this is a
      // no-op when the derived state already matches.
      if (node.checked === wanted) return;
      await withDeadline(client.interactions.click({ ...base, ...SETTLE }), operation, action.kind);
      return;
    }
    case 'scrollIntoView': {
      // One gesture toward the target, in its own scroll container when it has
      // one. A single gesture may not be enough to reach a distant target;
      // `screen.scrollUntilVisible` is the loop that re-resolves each round.
      const direction = scrollDirectionToward(node, scope.viewport);
      if (direction === undefined) return;
      const container = nearestScrollContainer(node);
      const rect = container?.rect;
      if (rect === undefined) {
        await performScroll(client, scope, direction, 'slow', operation);
      } else {
        await performSwipe(client, scope, rect, direction, 'slow', operation);
      }
      return;
    }
    case 'swipe': {
      await performSwipe(
        client,
        scope,
        requireRect(control),
        action.direction,
        action.momentum ?? 'none',
        operation,
      );
      return;
    }
    case 'hover':
      throw unsupported('hover; a touch screen has no hover state');
    case 'selectOption':
      throw unsupported('selectOption; mobile pickers are driven by tap and scroll');
    case 'setInputFiles':
      throw unsupported('setInputFiles; there is no file input on mobile');
    case 'dragTo':
      throw unsupported('dragTo');
  }
}

/**
 * Which way to scroll to bring a node into the viewport, or undefined when it
 * is already inside it. Vertical displacement wins when both axes are off,
 * because mobile lists scroll vertically.
 */
function scrollDirectionToward(
  node: ProjectedNode,
  viewport: { readonly width: number; readonly height: number } | undefined,
): ScrollDirection | undefined {
  const rect = node.rect;
  if (rect === undefined || viewport === undefined) return 'down';
  const centerY = rect.y + rect.height / 2;
  const centerX = rect.x + rect.width / 2;
  if (centerY > viewport.height) return 'down';
  if (centerY < 0) return 'up';
  if (centerX > viewport.width) return 'right';
  if (centerX < 0) return 'left';
  return undefined;
}

/** The viewport point one node dispatches coordinate input at. */
function pointOf(
  scope: InteractionScope,
  node: ProjectedNode,
): { platform: 'ios' | 'android'; x: number; y: number } {
  return { platform: scope.platform, ...rectCenter(requireRect(node)) };
}

/** Runs a swipe across one rect with the momentum's distance and duration. */
export async function performSwipe(
  client: AgentDeviceClient,
  scope: InteractionScope,
  rect: NonNullable<ProjectedNode['rect']>,
  direction: ScrollDirection,
  momentum: Momentum,
  operation: OperationContext,
): Promise<void> {
  const { from, to } = swipePath(rect, direction);
  const { durationMs } = momentumGesture(momentum);
  await withDeadline(
    client.interactions.pan({
      platform: scope.platform,
      x: Math.round(from.x),
      y: Math.round(from.y),
      dx: Math.round(to.x - from.x),
      dy: Math.round(to.y - from.y),
      durationMs,
    }),
    operation,
    'swipe',
  );
  await settleAfterGesture(client, scope, operation);
}

/** Scrolls the viewport, or one node's scroll container, by one momentum step. */
export async function performScroll(
  client: AgentDeviceClient,
  scope: InteractionScope,
  direction: ScrollDirection,
  momentum: Momentum,
  operation: OperationContext,
): Promise<void> {
  // Distance only: agent-device 0.20.2 turns a `scroll` with `durationMs` into
  // a no-op on iOS, verified by measuring a row's position across a scroll with
  // and without it. Momentum distance is what reaches content, so the gesture
  // duration is left to the backend rather than silently scrolling nothing.
  const { amount } = momentumGesture(momentum);
  await withDeadline(
    client.interactions.scroll({ platform: scope.platform, direction, amount }),
    operation,
    'scroll',
  );
  await settleAfterGesture(client, scope, operation);
}
