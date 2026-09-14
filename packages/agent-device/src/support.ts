/** Shared helpers for the agent-device engine: error constructors, filenames, PNG headers, gestures, the screen location and size. */

import { EngineError, type Momentum, type ScrollDirection } from 'e2e/engine';

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
 * of the rect's extent scaled by momentum, and never leaves the rect.
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
export interface RawScreenshotResult {
  readonly path?: string;
  readonly width?: number;
  readonly height?: number;
  readonly logicalWidth?: number;
  readonly logicalHeight?: number;
  readonly pixelDensity?: number;
}

/**
 * The device's logical screen size as its screenshot reports it, in points:
 * the logical dimensions when given, else the pixel dimensions over the
 * density. Undefined when the response carries neither.
 */
export function logicalScreenSize(
  result: RawScreenshotResult,
): { readonly width: number; readonly height: number; readonly scale: number } | undefined {
  const logical =
    result.logicalWidth !== undefined && result.logicalHeight !== undefined
      ? { width: result.logicalWidth, height: result.logicalHeight }
      : result.width !== undefined && result.height !== undefined && result.pixelDensity !== undefined && result.pixelDensity > 0
        ? { width: result.width / result.pixelDensity, height: result.height / result.pixelDensity }
        : undefined;
  if (logical === undefined || logical.width <= 0 || logical.height <= 0) return undefined;
  return { ...logical, scale: 1 };
}
