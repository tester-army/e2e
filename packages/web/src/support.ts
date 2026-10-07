/** Shared error translation, filename, and swipe helpers for the Playwright engine. */

import { setTimeout } from 'node:timers/promises';
import type { ElementHandle, Locator as PwLocator, Mouse, Page } from 'playwright-core';
import { EngineError, withinCleanupBudget, type EngineCleanupContext, type Momentum, type ScrollDirection, type ViewportPoint, type ViewportSize } from 'e2e/engine';
import { ConfigurationError, InfrastructureError, TestError } from 'e2e/engine';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * The page's viewport in CSS pixels: the emulated size when one is set, else
 * the window's, measured in the page, since `viewport: null` follows the
 * window and Playwright then reports no size of its own.
 */
export async function currentViewport(page: Page): Promise<ViewportSize> {
  const emulated = page.viewportSize();
  if (emulated !== null) return emulated;
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

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
type Actionable = Pick<
  PwLocator,
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'press'
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
  const viewport = await currentViewport(page);
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
    throw new EngineError('NOT_ACTIONABLE', 'a drag endpoint has no visible bounding box', {
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
      throw new EngineError(
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

/** Playwright colorizes call logs; escape codes are noise in reports. */
// oxlint-disable-next-line no-control-regex -- intentionally matches the ESC control character
const ANSI_PATTERN = /\u001b\[\d+(?:;\d+)*m/g;

/** A failure's message with terminal control sequences removed. */
export function message(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(ANSI_PATTERN, '');
}

/** Constrains a caller-supplied artifact label to a safe filename. */
export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}

export function isPwTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

export function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

export function cancelled(text: string): EngineError {
  return new EngineError('CANCELLED', text, { retryable: false });
}

/**
 * Holds one error raised on a path nobody awaits - a native dialog nobody
 * handled, a route handler that broke its contract - until the next step
 * enters the surface, which then fails with the real cause, or until the
 * attempt settles when no step follows. Rethrows once: the failure belongs
 * to the step that observes it, not to every later one.
 */
export class ErrorLatch {
  private pending: Error | null = null;
  private readonly running = new Map<Promise<void>, string>();
  private abandoned = false;

  /** Latches an error; the first one wins until it is thrown. Dropped once `settle` gave up on a handler. */
  latch(error: Error): void {
    if (this.abandoned) return;
    this.pending ??= error;
  }

  /** Tracks one unawaited `kind` of path (a route or dialog handler) until it settles, so `settle` can wait for it. Its own rejection is the caller's to latch. */
  track(kind: string, work: Promise<void>): void {
    const tracked: Promise<void> = work.then(() => undefined, () => undefined);
    this.running.set(tracked, kind);
    void tracked.then(() => this.running.delete(tracked));
  }

  /**
   * Rethrows the latched error once; with none latched yet, first waits,
   * within the budget, for the tracked paths running when it was called. One
   * of those that outlives the budget fails closed: `CLEANUP_TIMEOUT` naming
   * it, and whatever it throws afterwards is dropped here on purpose rather
   * than landing on a verdict already reached. A path that starts during the
   * wait is left to the next settle.
   */
  async settle(budget: EngineCleanupContext): Promise<void> {
    this.throwPending();
    if (!this.abandoned && this.running.size > 0) {
      const waited = [...this.running.keys()];
      await withinCleanupBudget(Promise.all(waited), budget);
      const outlived = waited.filter((path) => this.running.has(path));
      if (outlived.length > 0) {
        const kinds = [...new Set(outlived.map((path) => this.running.get(path)))].toSorted().join(' and ');
        this.running.clear();
        this.abandoned = true;
        this.throwPending();
        throw new InfrastructureError(
          'CLEANUP_TIMEOUT',
          `a ${kinds} handler was still running when the cleanup budget ended; anything it throws now is dropped`,
        );
      }
    }
    this.throwPending();
  }

  /** Rethrows the latched error once, if any. */
  throwPending(): void {
    if (this.pending !== null) {
      const error = this.pending;
      this.pending = null;
      throw error;
    }
  }
}

/**
 * The runner error classes as their `name` reads. A project can load this
 * engine against a copy of `e2e` other than the one the runner's core runs
 * from (and e2e before 0.17 always loaded config in a module realm of its
 * own), so a runner error reaching the engine can be a `TestError` this
 * module never imported: `instanceof` says no while `name` and `code` still
 * tell the truth.
 */
const CLASSIFIED_NAMES: ReadonlySet<string> = new Set([
  'EngineError',
  'TestError',
  'ConfigurationError',
  'InfrastructureError',
]);

/**
 * True for an error that already carries its classification: an `EngineError`
 * or a runner error (policy, validation, timeout) from any module copy. Those
 * must cross the boundary untouched; re-wrapping one would turn a
 * `POLICY_DENIED` into an infrastructure failure.
 */
export function isClassified(cause: unknown): cause is Error {
  if (cause instanceof EngineError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && CLASSIFIED_NAMES.has(cause.name);
}

/**
 * True for a `TestError` carrying `code`, from this module copy or another.
 * A matcher that reads a node it may be early for asks this before deciding
 * whether the miss is one more poll or the assertion's failure.
 */
export function isTestErrorCode(cause: unknown, code: string): cause is Error & { readonly code: string } {
  return cause instanceof Error && cause.name === 'TestError' && (cause as { code?: unknown }).code === code;
}

/**
 * How a Playwright failure maps onto the error contract. Every translator in
 * this package and in `actions.ts` follows this table:
 *
 * | Playwright failure                                              | Code                      |
 * | --------------------------------------------------------------- | ------------------------- |
 * | already an EngineError / runner error                           | passed through untouched  |
 * | `TimeoutError` on a read, navigation, or artifact call          | OPERATION_TIMEOUT         |
 * | `TimeoutError` on an action, log ends before the input dispatch | NOT_ACTIONABLE            |
 * | `TimeoutError` on an action, log shows the dispatch started     | ACTION_MAY_HAVE_COMMITTED |
 * | operation deadline cut off an action, pointer, or keyboard call | ACTION_MAY_HAVE_COMMITTED |
 * | element detached / not attached / no element / resolved hidden  | NODE_STALE (retryable)    |
 * | execution context destroyed / frame detached by a navigation    | NODE_STALE (retryable)    |
 * | strict mode violation, log ends before the input dispatch       | NODE_STALE (retryable)    |
 * | strict mode violation, log shows the dispatch started           | ACTION_MAY_HAVE_COMMITTED |
 * | not an input / not editable / not checkable                     | NOT_ACTIONABLE            |
 * | anything else                                                   | ENGINE_FAILURE            |
 *
 * The action split is read from the call log Playwright appends to a timeout
 * or strict mode message: `performing <x> action`, `<x> action done`, and
 * `waiting for scheduled navigations to finish` are only logged once the input
 * is being (or has been) dispatched, so a failure whose log reaches them is
 * uncertain and the harness must not blindly repeat it. Every earlier line
 * (`waiting for element to be visible, enabled and stable`, `scrolling into
 * view if needed`, `retrying <x> action`) precedes dispatch and is a plain
 * actionability miss. Only whole `- ` log lines count, so a locator or element
 * text quoting those words never does.
 */
export const POST_DISPATCH_PATTERN =
  /^\s*- (performing \w+ action|[\w ]+ action done|waiting for scheduled navigations to finish)\s*$/im;

/** Translates an unexpected Playwright error at the contract boundary. */
export function translatePwError(cause: unknown, operation: string): Error {
  if (isClassified(cause)) return cause;
  if (isPwTimeout(cause)) {
    return new EngineError('OPERATION_TIMEOUT', `${operation} timed out: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return new EngineError('ENGINE_FAILURE', `${operation} failed: ${message(cause)}`, {
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
export function navigationStaleOr(cause: unknown, operation: string): Error {
  if (!isClassified(cause) && isNavigationRace(cause)) {
    return new EngineError('NODE_STALE', `${operation}: ${message(cause)}`, {
      retryable: true,
      cause,
    });
  }
  return translatePwError(cause, operation);
}

/**
 * Like translatePwError, but detachment/miss failures become retryable
 * NODE_STALE. A timeout stays a timeout: `locate` resolves once and never
 * waits, so a `TimeoutError` there is a budget that ran out, not a miss.
 */
export function staleOr(cause: unknown, operation: string): Error {
  if (isClassified(cause)) return cause;
  const text = message(cause);
  if (STALE_PATTERN.test(text) || isNavigationRace(cause)) {
    return new EngineError('NODE_STALE', `${operation}: ${text}`, { retryable: true, cause });
  }
  return translatePwError(cause, operation);
}

export async function performViewportSwipe(
  page: Page,
  direction: ScrollDirection,
  momentum: Momentum,
): Promise<void> {
  const viewport = await currentViewport(page);
  const distance = swipeDistance(
    direction === 'up' || direction === 'down' ? viewport.height : viewport.width,
    momentum,
  );
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  return page.mouse.wheel(deltaX, deltaY);
}

/**
 * The browser truncates a fractional pointer coordinate, so a point composed
 * from a fractional box (`tap({ position })` on a node at y 148.875) would
 * land on the pixel before the one asked for; it is rounded to the nearest
 * CSS pixel instead.
 */
export function nearestPixel(point: ViewportPoint): ViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/** A pointer drag from one viewport point to another, on whole pixels, with an intermediate move so drag handlers see motion; paced over `durationMs` when given. */
export async function performPointDrag(
  mouse: Mouse,
  start: ViewportPoint,
  end: ViewportPoint,
  durationMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  const from = nearestPixel(start);
  const to = nearestPixel(end);
  const middle = nearestPixel({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  await mouse.move(from.x, from.y);
  await mouse.down();
  try {
    if (durationMs !== undefined) {
      const steps = Math.max(2, Math.round(durationMs / 16));
      const startedAt = performance.now();
      for (let step = 1; step <= steps; step += 1) {
        const due = startedAt + (durationMs * step) / steps;
        await setTimeout(Math.max(0, due - performance.now()), undefined, { signal });
        await mouse.move(
          from.x + ((to.x - from.x) * step) / steps,
          from.y + ((to.y - from.y) * step) / steps,
        );
      }
    } else {
      await mouse.move(middle.x, middle.y);
      await mouse.move(to.x, to.y);
    }
  } finally {
    await mouse.up();
  }
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
    throw new EngineError('NOT_ACTIONABLE', 'element has no visible bounding box', {
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
