/** Shared helpers for the agent-device engine: error constructors, filenames, PNG headers, gestures, the screen location and size. */

import type { CaptureScreenshotResult } from 'agent-device';
import { EngineError, withTimeout, type Momentum, type ScrollDirection, type ViewportSize } from 'e2e/engine';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function cancelled(text: string): EngineError {
  return new EngineError('CANCELLED', text, { retryable: false });
}

/**
 * The least time an input gets to answer once sent, however little budget
 * was left: a tap that lands is then not reported as cut off.
 */
const MIN_ANSWER_MS = 250;

/**
 * One input operation's budget (`actionTimeout`, or the call's `timeout`),
 * which the harness signal does not enforce. Only the device commands that
 * send input run under it; reads stay unbounded, so a locator poll keeps its
 * last snapshot and a target settling before a tap is relocated in full.
 */
export class InputBudget {
  private readonly endsAt: number;
  private sent = false;

  /**
   * `track` keeps the device command itself in flight, past a timeout that
   * abandons it, until it settles. The callers' own tracking settles with the
   * race, so this is the registration the next attempt waits on.
   */
  constructor(
    private readonly label: string,
    timeoutMs: number,
    private readonly track: <T>(pending: Promise<T>) => Promise<T>,
  ) {
    this.endsAt = Date.now() + timeoutMs;
  }

  /**
   * Sends one input with what is left of the budget. With none left it sends
   * nothing: `OPERATION_TIMEOUT`, or `ACTION_MAY_HAVE_COMMITTED` once an
   * earlier input of this operation went out. A gesture that holds (`holdMs`)
   * at least as long as the budget left could only be cut off mid-gesture, so
   * it is refused unsent. An input that does not answer in time may have
   * landed, so it is `ACTION_MAY_HAVE_COMMITTED` and the runner never repeats it.
   */
  send<T>(dispatch: () => Promise<T>, holdMs = 0): Promise<T> {
    const remaining = this.endsAt - Date.now();
    if (remaining <= 0) {
      return Promise.reject(
        this.sent ? this.maybeCommitted() : new EngineError('OPERATION_TIMEOUT', `${this.label} timed out before it was sent`, { retryable: false }),
      );
    }
    if (holdMs >= remaining) {
      return Promise.reject(
        new EngineError(
          'NOT_ACTIONABLE',
          `${this.label} holds for ${holdMs} ms, but only ${Math.floor(remaining)} ms of its timeout are left; raise the timeout or shorten the hold`,
          { retryable: false },
        ),
      );
    }
    const pending = this.track(dispatch());
    this.sent = true;
    return withTimeout(pending, Math.max(remaining, MIN_ANSWER_MS), () => this.maybeCommitted());
  }

  private maybeCommitted(): EngineError {
    return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${this.label} timed out before the device answered; its input may have been dispatched`, {
      retryable: false,
    });
  }
}

export function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

/** Constrains a caller-supplied artifact label to a safe filename. */
export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Reads the dimensions out of a PNG's IHDR chunk; undefined for anything else. */
export function readPngSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  for (const [offset, byte] of PNG_SIGNATURE.entries()) {
    if (data[offset] !== byte) return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The finger gesture that scrolls one rect's content in `direction`. Scrolling
 * down reveals what is below, so the finger travels up; the travel is a share
 * of the rect's extent scaled by momentum, and never leaves the rect. The
 * root scroll sends no share (agent-device's default, see `perform`); these
 * are for a gesture inside one control, and deterministic tests step through
 * a list with `slow`, a quarter of the box, shorter than any row, so every
 * row lands fully on screen at some stop. At three quarters the mobile
 * benchmark's scenario list dragged rows past.
 */
export function swipeWithin(
  rect: Rect,
  direction: ScrollDirection,
  momentum: Momentum | undefined,
): { from: Point; to: Point } {
  const ratio = momentum === 'fast' ? 0.8 : momentum === 'slow' ? 0.25 : 0.5;
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const dx = (rect.width * ratio) / 2;
  const dy = (rect.height * ratio) / 2;
  switch (direction) {
    case 'down':
      return { from: { x: centre.x, y: centre.y + dy }, to: { x: centre.x, y: centre.y - dy } };
    case 'up':
      return { from: { x: centre.x, y: centre.y - dy }, to: { x: centre.x, y: centre.y + dy } };
    case 'right':
      return { from: { x: centre.x + dx, y: centre.y }, to: { x: centre.x - dx, y: centre.y } };
    case 'left':
      return { from: { x: centre.x - dx, y: centre.y }, to: { x: centre.x + dx, y: centre.y } };
  }
}

/**
 * The location a device surface reports in a snapshot: the foreground app
 * and the screen shown, `<app> / <screen title>`. A simulator has no address
 * bar, so this is an opaque address the harness shows to the model and the
 * report and anchors trace replay on; it changes exactly when the app or its
 * screen changes. It is deliberately not a URL: no scheme, no colon, so the
 * harness never mistakes it for one and applies an origin policy to it.
 * Undefined when neither the app nor a title is known.
 */
export function screenLocation(app: string | undefined, title: string | undefined): string | undefined {
  const parts = [app, title]
    .map((part) => (part === undefined ? '' : part.replaceAll(/\s+/g, ' ').trim()))
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(' / ');
}

/** The screenshot fields a viewport probe reads off agent-device's response. */
export type RawScreenshotResult = Partial<Pick<CaptureScreenshotResult, 'path' | 'width' | 'height' | 'logicalWidth' | 'logicalHeight' | 'pixelDensity'>>;

/**
 * The device's logical screen size as its screenshot reports it, in points:
 * the logical dimensions when given, else the pixel dimensions over the
 * density. Undefined when the response carries neither.
 */
export function logicalScreenSize(
  result: RawScreenshotResult,
): ViewportSize | undefined {
  const logical =
    result.logicalWidth !== undefined && result.logicalHeight !== undefined
      ? { width: result.logicalWidth, height: result.logicalHeight }
      : result.width !== undefined && result.height !== undefined && result.pixelDensity !== undefined && result.pixelDensity > 0
        ? { width: result.width / result.pixelDensity, height: result.height / result.pixelDensity }
        : undefined;
  if (logical === undefined || logical.width <= 0 || logical.height <= 0) return undefined;
  return logical;
}
