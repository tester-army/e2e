/** Shared error translation, filename, and swipe helpers for the Playwright driver. */

import type { ElementHandle, Locator as PwLocator, Page } from 'playwright';
import { DriverError, type Momentum, type ScrollDirection } from '../driver/index.ts';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * A resolved node is addressed either by a deterministic locator expression or
 * by a live element handle captured during one agent observation.
 */
export type ActionTarget =
  | { readonly kind: 'locator'; readonly locator: PwLocator }
  | { readonly kind: 'element'; readonly element: ElementHandle<Node> };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TimeoutOptions {
  timeout: number;
}

/** Uniform action surface over locator-backed and handle-backed targets. */
export interface Actionable {
  click(options: TimeoutOptions & { delay?: number }): Promise<void>;
  dblclick(options: TimeoutOptions): Promise<void>;
  fill(value: string, options: TimeoutOptions): Promise<void>;
  press(key: string, options: TimeoutOptions): Promise<void>;
  check(options: TimeoutOptions): Promise<void>;
  uncheck(options: TimeoutOptions): Promise<void>;
  focus(options: TimeoutOptions): Promise<void>;
  scrollIntoViewIfNeeded(options: TimeoutOptions): Promise<void>;
  selectOption(
    value: { label?: string; index?: number },
    options: TimeoutOptions,
  ): Promise<unknown>;
  hover(options: TimeoutOptions): Promise<void>;
  boundingBox(options: TimeoutOptions): Promise<Rect | null>;
  dragTo(target: ActionTarget, options: TimeoutOptions): Promise<void>;
  evaluate<Result, Arg>(
    fn: (element: never, arg: Arg) => Result,
    arg: Arg,
    options: TimeoutOptions,
  ): Promise<Result>;
  page(): Promise<Page>;
}

/** Adapts one action target to the uniform surface used by action dispatch. */
export function asActionable(target: ActionTarget): Actionable {
  if (target.kind === 'locator') {
    const locator = target.locator;
    return {
      click: (options) => locator.click(options),
      dblclick: (options) => locator.dblclick(options),
      fill: (value, options) => locator.fill(value, options),
      press: (key, options) => locator.press(key, options),
      check: (options) => locator.check(options),
      uncheck: (options) => locator.uncheck(options),
      focus: (options) => locator.focus(options),
      scrollIntoViewIfNeeded: (options) => locator.scrollIntoViewIfNeeded(options),
      selectOption: (value, options) => locator.selectOption(value, options),
      hover: (options) => locator.hover(options),
      boundingBox: (options) => locator.boundingBox(options),
      dragTo: (other, options) => {
        if (other.kind !== 'locator') throw unsupportedDrag();
        return locator.dragTo(other.locator, options);
      },
      evaluate: (fn, arg, options) =>
        locator.evaluate(fn as never, arg, options) as never,
      page: () => Promise.resolve(locator.page()),
    };
  }
  const element = target.element;
  return {
    click: (options) => element.click(options),
    dblclick: (options) => element.dblclick(options),
    fill: (value, options) => element.fill(value, options),
    press: (key, options) => element.press(key, options),
    check: (options) => element.check(options),
    uncheck: (options) => element.uncheck(options),
    focus: () => element.focus(),
    scrollIntoViewIfNeeded: (options) => element.scrollIntoViewIfNeeded(options),
    selectOption: (value, options) => element.selectOption(value, options),
    hover: (options) => element.hover(options),
    boundingBox: () => element.boundingBox(),
    dragTo: () => Promise.reject(unsupportedDrag()),
    evaluate: (fn, arg) => element.evaluate(fn as never, arg) as never,
    page: async () => {
      const frame = await element.ownerFrame();
      if (frame === null) throw invalidState('element is detached from every frame');
      return frame.page();
    },
  };
}

function unsupportedDrag(): DriverError {
  return new DriverError('UNSUPPORTED_CAPABILITY', 'dragTo requires a locator-backed target', {
    retryable: false,
  });
}

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
  const actionable = asActionable(target);
  const box = await actionable.boundingBox({ timeout });
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
  const page = await actionable.page();
  await actionable.hover({ timeout });
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
