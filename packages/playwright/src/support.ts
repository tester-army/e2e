/** Shared error translation, filename, and swipe helpers for the Playwright driver. */

import type { ElementHandle, Locator as PwLocator, Page } from 'playwright';
import { DriverError, type Momentum, type ScrollDirection } from 'e2e/driver';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * A resolved node is addressed either by a deterministic locator expression or
 * by a live element handle captured during one agent observation. Handles are
 * always elements: the in-page observation walk records `Element` nodes only.
 */
export type ActionTarget =
  | { readonly kind: 'locator'; readonly locator: PwLocator }
  | { readonly kind: 'element'; readonly element: ElementHandle<Element> };

export interface Rect {
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
export async function targetPage(target: ActionTarget): Promise<Page> {
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
export function targetBoundingBox(target: ActionTarget, timeout: number): Promise<Rect | null> {
  return target.kind === 'locator'
    ? target.locator.boundingBox({ timeout })
    : target.element.boundingBox();
}

export function unsupportedDrag(): DriverError {
  return new DriverError('UNSUPPORTED_CAPABILITY', 'dragTo requires locator-backed targets', {
    retryable: false,
  });
}

/** Playwright colorizes call logs; escape codes are noise in reports. */
// oxlint-disable-next-line no-control-regex -- intentionally matches the ESC control character
const ANSI_PATTERN = /\u001b\[\d+(?:;\d+)*m/g;

export function message(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(ANSI_PATTERN, '');
}

export function isPwTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

export function invalidState(text: string): DriverError {
  return new DriverError('INVALID_STATE', text, { retryable: false });
}

/** Translates an unexpected Playwright error at the SPI boundary. */
export function translatePwError(cause: unknown, operation: string): DriverError {
  if (cause instanceof DriverError) return cause;
  if (isPwTimeout(cause)) {
    return new DriverError('OPERATION_TIMEOUT', `${operation} timed out: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return new DriverError('DRIVER_FAILURE', `${operation} failed: ${message(cause)}`, {
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
export function isNavigationRace(cause: unknown): boolean {
  return NAVIGATION_RACE_PATTERN.test(message(cause));
}

/**
 * Like translatePwError, but a read that lost its document to a navigation
 * becomes retryable NODE_STALE so the runner re-reads the new document instead
 * of failing the call. Timeouts keep their meaning: an observation that cannot
 * be captured in time is not a race.
 */
export function navigationStaleOr(cause: unknown, operation: string): DriverError {
  if (!(cause instanceof DriverError) && isNavigationRace(cause)) {
    return new DriverError('NODE_STALE', `${operation}: ${message(cause)}`, {
      retryable: true,
      cause,
    });
  }
  return translatePwError(cause, operation);
}

/** Like translatePwError, but detachment/miss failures become retryable NODE_STALE. */
export function staleOr(cause: unknown, operation: string): DriverError {
  const text = message(cause);
  if (STALE_PATTERN.test(text) || isNavigationRace(cause) || isPwTimeout(cause)) {
    return new DriverError('NODE_STALE', `${operation}: ${text}`, { retryable: true, cause });
  }
  return translatePwError(cause, operation);
}

export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
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
    throw new DriverError('NOT_ACTIONABLE', 'element has no visible bounding box', {
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
