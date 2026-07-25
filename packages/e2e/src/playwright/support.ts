/** Shared error translation, filename, and swipe helpers for the Playwright driver. */

import type { Locator as PwLocator, Page } from 'playwright';
import { DriverError, type Momentum, type ScrollDirection } from '../driver/index.js';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

/** Like translatePwError, but detachment/miss failures become retryable NODE_STALE. */
export function staleOr(cause: unknown, operation: string): DriverError {
  const text = message(cause);
  if (/detached|not attached|resolved to hidden|no element|not found/i.test(text) || isPwTimeout(cause)) {
    return new DriverError('NODE_STALE', `${operation}: ${text}`, { retryable: true, cause });
  }
  return translatePwError(cause, operation);
}

export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._\-]/g, '_').slice(0, 64) || 'artifact';
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
  locator: PwLocator,
  direction: ScrollDirection,
  momentum: Momentum,
  timeout: number,
): Promise<void> {
  const box = await locator.boundingBox({ timeout });
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
  await locator.hover({ timeout });
  await locator.page().mouse.wheel(deltaX, deltaY);
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
