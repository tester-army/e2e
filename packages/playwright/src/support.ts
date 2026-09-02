/** Shared error translation, filename, and swipe helpers for the Playwright backend. */

import type { ElementHandle, Locator as PwLocator, Page } from 'playwright';
import { BackendError, type Momentum, type ScrollDirection } from 'e2e/backend';
import { causeMessage as message, ConfigurationError, InfrastructureError, sanitizeFilename, TestError } from 'e2e/internal';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

interface Point {
  x: number;
  y: number;
}

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function withinViewport(point: Point, viewport: { width: number; height: number }): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;
}

/**
 * A resolved node is addressed either by a deterministic locator expression or
 * by a live element handle captured during one agent observation. Handles are
 * always elements: the in-page observation walk records `Element` nodes only.
 */
export type ActionTarget =
  | { readonly kind: 'locator'; readonly locator: PwLocator }
  | { readonly kind: 'element'; readonly element: ElementHandle<Element> };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Action surface Locator and ElementHandle share with identical signatures.
 * Operations whose behavior diverges between the two kinds (bounding box,
 * evaluate, page ownership, drag) have explicit helpers below so every fork is
 * visible at its call site instead of hidden behind a uniform interface.
 */
export type Actionable = Pick<
  PwLocator,
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'press'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'scrollIntoViewIfNeeded'
  | 'selectOption'
  | 'setInputFiles'
>;

/** Narrows one action target to the shared Playwright action surface. */
export function asActionable(target: ActionTarget): Actionable {
  return target.kind === 'locator' ? target.locator : target.element;
}

/** Owning page of one action target. */
async function targetPage(target: ActionTarget): Promise<Page> {
  if (target.kind === 'locator') return target.locator.page();
  const frame = await target.element.ownerFrame();
  if (frame === null) throw invalidState('element is detached from every frame');
  return frame.page();
}

/**
 * Bounding box of one action target. A locator waits up to `timeout` for its
 * element to resolve; an element handle is already resolved, so its box is
 * read immediately.
 */
function targetBoundingBox(target: ActionTarget, timeout: number): Promise<Rect | null> {
  return target.kind === 'locator'
    ? target.locator.boundingBox({ timeout })
    : target.element.boundingBox();
}

/** Minimal scroll that brings one target into view, without centring it. */
async function scrollIntoViewNearest(target: ActionTarget): Promise<void> {
  const scroll = (el: Element): void => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  if (target.kind === 'locator') await target.locator.evaluate(scroll);
  else await target.element.evaluate(scroll);
}

/**
 * Drags one target onto another with the pointer.
 *
 * `Locator.dragTo` exists but takes a locator on both sides, and a node the
 * agent reached through its observed reference is an element handle — which used
 * to make the whole verb unavailable for exactly the elements that have no
 * locator: an unlabelled thumbnail, an empty drop zone. Driving the pointer
 * works for both kinds because a handle has a bounding box like anything else.
 *
 */
export async function performPointerDrag(
  source: ActionTarget,
  destination: ActionTarget,
  timeout: number,
): Promise<void> {
  // Hover the source first: it auto-waits for actionability and scrolls the
  // source into view, and the gesture starts there, so its position is the one
  // that has to hold.
  await asActionable(source).hover({ timeout });
  const page = await targetPage(source);
  const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
  let from = await targetBoundingBox(source, timeout);
  let to = await targetBoundingBox(destination, timeout);

  // A pointer can only be put at a viewport coordinate, so a destination below
  // the fold has to be brought into view — `Locator.dragTo` scrolls both sides,
  // and a pointer sequence that skips it aims where no element is and drops
  // nothing.
  //
  // Neither obvious tool fits. `scrollIntoViewIfNeeded` centres the destination,
  // which pushes the source out and costs the position hovering just
  // established. `mouse.wheel` does not wait for the scroll it causes, so the
  // boxes read after it are a race. `scrollIntoView({ block: 'nearest' })`
  // scrolls the smallest amount that reveals the element, synchronously, which
  // keeps both endpoints on screen whenever they can be.
  if (to !== null && !withinViewport(centreOf(to), viewport)) {
    await scrollIntoViewNearest(destination);
    from = await targetBoundingBox(source, timeout);
    to = await targetBoundingBox(destination, timeout);
  }

  if (from === null || to === null) {
    throw new BackendError('NOT_ACTIONABLE', 'a drag endpoint has no visible bounding box', {
      retryable: false,
    });
  }
  const start = centreOf(from);
  const end = centreOf(to);
  // Endpoints that cannot be on screen together are reported rather than dragged
  // between: a pointer sequence aimed off-screen looks like a drag that ran and
  // leaves the page untouched, which surfaces later as a confusing assertion
  // instead of the drag failure it is.
  for (const [label, point] of [
    ['source', start],
    ['destination', end],
  ] as const) {
    if (!withinViewport(point, viewport)) {
      throw new BackendError(
        'NOT_ACTIONABLE',
        `the drag ${label} is outside the viewport at (${Math.round(point.x)}, ${Math.round(point.y)}) ` +
          `of ${viewport.width}x${viewport.height}: the two endpoints cannot be reached in one gesture`,
        { retryable: false },
      );
    }
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Two moves: HTML5 drag-and-drop commits on `dragover`, and one move into the
  // destination does not always produce one.
  await page.mouse.move(end.x, end.y, { steps: 2 });
  await page.mouse.move(end.x, end.y);
  await page.mouse.up();
}

// Re-exported so the rest of the package keeps importing its text helpers from
// one place, whether they are shared with other backends or local to this one.
export { message, sanitizeFilename };

export function isPwTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

export function invalidState(text: string): BackendError {
  return new BackendError('INVALID_STATE', text, { retryable: false });
}

/**
 * True for an error that already carries its classification: a `BackendError`
 * from any module copy, or a runner error (policy, validation, timeout). Those
 * must cross the boundary untouched; re-wrapping one would turn a
 * `POLICY_DENIED` into an infrastructure failure.
 */
export function isClassified(cause: unknown): cause is Error {
  if (cause instanceof BackendError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && cause.name === 'BackendError';
}

/** Translates an unexpected Playwright error at the contract boundary. */
export function translatePwError(cause: unknown, operation: string): BackendError {
  if (isClassified(cause)) return cause as BackendError;
  if (isPwTimeout(cause)) {
    return new BackendError('OPERATION_TIMEOUT', `${operation} timed out: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return new BackendError('BACKEND_FAILURE', `${operation} failed: ${message(cause)}`, {
    retryable: false,
    cause,
  });
}

const STALE_PATTERN = /detached|not attached|resolved to hidden|no element|not found/i;

/**
 * A read that raced a navigation: the document it was reading was replaced
 * mid-flight. Nothing was dispatched, so the read is repeatable against the
 * new document — the same condition as a stale node, reported as one.
 */
const NAVIGATION_RACE_PATTERN =
  /execution context was destroyed|because of a navigation|navigating and changing the content|frame was detached|frame got detached|node is detached from document/i;

/** Whether a Playwright failure describes a read that lost its document to a navigation. */
function isNavigationRace(cause: unknown): boolean {
  return NAVIGATION_RACE_PATTERN.test(message(cause));
}

/**
 * Like translatePwError, but a read that lost its document to a navigation
 * becomes retryable NODE_STALE so the runner re-reads the new document instead
 * of failing the call. Timeouts keep their meaning: an observation that cannot
 * be captured in time is not a race.
 */
export function navigationStaleOr(cause: unknown, operation: string): BackendError {
  if (!isClassified(cause) && isNavigationRace(cause)) {
    return new BackendError('NODE_STALE', `${operation}: ${message(cause)}`, {
      retryable: true,
      cause,
    });
  }
  return translatePwError(cause, operation);
}

/** Like translatePwError, but detachment/miss failures become retryable NODE_STALE. */
export function staleOr(cause: unknown, operation: string): BackendError {
  if (isClassified(cause)) return cause as BackendError;
  const text = message(cause);
  if (STALE_PATTERN.test(text) || isNavigationRace(cause) || isPwTimeout(cause)) {
    return new BackendError('NODE_STALE', `${operation}: ${text}`, { retryable: true, cause });
  }
  return translatePwError(cause, operation);
}

export function performViewportSwipe(
  page: Page,
  direction: ScrollDirection,
  momentum: Momentum,
): Promise<void> {
  const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
  const distance = swipeDistance(
    direction === 'up' || direction === 'down' ? viewport.height : viewport.width,
    momentum,
  );
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  return page.mouse.wheel(deltaX, deltaY);
}

export async function performElementSwipe(
  target: ActionTarget,
  direction: ScrollDirection,
  momentum: Momentum,
  timeout: number,
): Promise<void> {
  // Hover first: it auto-waits for visibility on both target kinds, so the
  // immediate box read below observes a settled element.
  await asActionable(target).hover({ timeout });
  const box = await targetBoundingBox(target, timeout);
  if (box === null) {
    throw new BackendError('NOT_ACTIONABLE', 'element has no visible bounding box', {
      retryable: false,
    });
  }
  const distance = swipeDistance(
    direction === 'up' || direction === 'down' ? box.height : box.width,
    momentum,
  );
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  const page = await targetPage(target);
  await page.mouse.wheel(deltaX, deltaY);
}

function swipeDistance(extent: number, momentum: Momentum): number {
  const ratio = momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5;
  return Math.round(extent * ratio);
}

function wheelDelta(direction: ScrollDirection, distance: number): [number, number] {
  switch (direction) {
    case 'down':
      return [0, distance];
    case 'up':
      return [0, -distance];
    case 'right':
      return [distance, 0];
    case 'left':
      return [-distance, 0];
  }
}
