/** Shared helpers for the agent-device backend: abort racing, filenames, PNG headers, gestures, path anchors. */

import { BackendError, type Momentum, type ScrollDirection } from 'e2e/backend';

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

export function cancelled(text: string): BackendError {
  return new BackendError('CANCELLED', text, { retryable: false });
}

export function invalidState(text: string): BackendError {
  return new BackendError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): BackendError {
  return new BackendError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): BackendError {
  return new BackendError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

/**
 * Awaits `promise` unless `signal` aborts first, in which case the wait ends
 * with `CANCELLED`. agent-device commands take no signal, so the in-flight
 * call is not stopped; its eventual settlement is absorbed instead of
 * surfacing as an unhandled rejection.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(cancelled(`${label} cancelled`));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(cancelled(`${label} cancelled`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Best-effort cleanup wait: resolves when `promise` settles, when `signal`
 * aborts, or when `timeoutMs` elapses, whichever comes first. Cleanup never
 * throws through here; a close that outlives its budget is abandoned.
 */
export function withinCleanupBudget(
  promise: Promise<unknown>,
  budget: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, Math.max(0, budget.timeoutMs));
    budget.signal.addEventListener('abort', settle, { once: true });
    promise.then(settle, settle);
  });
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
 * The location a device surface reports through `url`. A simulator has no
 * address bar, but the trace cache anchors every recorded step on a path and
 * refuses to write a trace for a surface without one, so the backend mints
 * one: `app://device/<app>/<screen title>`. The cache compares pathnames
 * only, so the app identity lives in the path, not the host: two apps with a
 * screen called "General" must not share an anchor. `new URL(...)` parses
 * it, and its pathname changes exactly when the app or its screen changes.
 */
export function screenUrl(app: string | undefined, title: string | undefined): string {
  const identity = (app ?? '').replaceAll(/[^A-Za-z0-9.-]/g, '-').replaceAll(/^-+|-+$/g, '').toLowerCase() || 'unknown';
  const trimmed = title === undefined ? '' : title.replaceAll(/\s+/g, ' ').trim();
  return `app://device/${identity}/${trimmed === '' ? '' : encodeURIComponent(trimmed)}`;
}
