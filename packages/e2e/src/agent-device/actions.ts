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
} from '../driver/index.ts';
import type { AgentDeviceClient } from './client.ts';
import type { ProjectedNode } from './snapshot.ts';
import { momentumGesture, rectCenter, swipePath, unsupported, withDeadline } from './support.ts';

/** Selection fields every interaction carries so the daemon targets one device. */
export interface InteractionScope {
  readonly platform: 'ios' | 'android';
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
  // `scrollIntoView` is what a test calls to make an off-screen node hittable,
  // so it is the one action that does not require hit testability up front.
  if (!node.hittable && action !== 'scrollIntoView') {
    throw new DriverError('NOT_ACTIONABLE', `node ${node.ref} is not hit testable`, {
      retryable: false,
    });
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
  const base = { platform: scope.platform, ref: node.ref } as const;
  switch (action.kind) {
    case 'tap':
      await withDeadline(client.interactions.click({ ...base }), operation, 'tap');
      return;
    case 'doubleTap':
      await withDeadline(
        client.interactions.click({ ...base, doubleTap: true }),
        operation,
        'doubleTap',
      );
      return;
    case 'longPress':
      await withDeadline(
        client.interactions.longPress({
          ...base,
          ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
        }),
        operation,
        'longPress',
      );
      return;
    case 'fill':
    case 'clear': {
      // `clear` is a fill with empty text: both replace the field's content.
      const text = action.kind === 'fill' ? action.value : '';
      const options = { ...base, text };
      // oxlint-disable-next-line no-array-fill-with-reference-type -- this is the daemon's fill command, not Array#fill
      await withDeadline(client.interactions.fill(options), operation, action.kind);
      return;
    }
    case 'focus':
      await withDeadline(client.interactions.focus(pointOf(scope, node)), operation, 'focus');
      return;
    case 'press':
      // A key press targets the focused field, so focus the node first.
      await withDeadline(client.interactions.focus(pointOf(scope, node)), operation, 'press');
      await withDeadline(
        client.interactions.type({ platform: scope.platform, text: action.key }),
        operation,
        'press',
      );
      return;
    case 'check':
    case 'uncheck': {
      const wanted = action.kind === 'check';
      // Toggling an already-correct control would invert it, so this is a
      // no-op when the derived state already matches.
      if (node.checked === wanted) return;
      await withDeadline(client.interactions.click({ ...base }), operation, action.kind);
      return;
    }
    case 'scrollIntoView': {
      await withDeadline(
        client.interactions.scroll({
          platform: scope.platform,
          direction: 'down',
          amount: momentumGesture('slow').amount,
        }),
        operation,
        'scrollIntoView',
      );
      return;
    }
    case 'swipe': {
      await performSwipe(
        client,
        scope,
        requireRect(node),
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
}

/** Scrolls the viewport, or one node's scroll container, by one momentum step. */
export async function performScroll(
  client: AgentDeviceClient,
  scope: InteractionScope,
  direction: ScrollDirection,
  momentum: Momentum,
  operation: OperationContext,
): Promise<void> {
  const { amount, durationMs } = momentumGesture(momentum);
  await withDeadline(
    client.interactions.scroll({ platform: scope.platform, direction, amount, durationMs }),
    operation,
    'scroll',
  );
}
