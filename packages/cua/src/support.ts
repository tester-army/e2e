/** Shared helpers for the Cua Driver engine: error constructors, filenames, PNG headers, geometry, path anchors. */

import { EngineError } from '@e2edev/e2e/engine';

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
 * The location a desktop surface reports through `url`. A window has no
 * address bar, but the trace cache anchors every recorded step on a path and
 * refuses to write a trace for a surface without one, so the engine mints
 * one: `app://desktop/<app>/<window title>`. The cache compares pathnames
 * only, so the app identity lives in the path, not the host: two apps with a
 * window called "Untitled" must not share an anchor. `new URL(...)` parses
 * it, and its pathname changes exactly when the app or its window changes.
 */
export function windowUrl(app: string | undefined, title: string | undefined): string {
  const identity = (app ?? '').replaceAll(/[^A-Za-z0-9.-]/g, '-').replaceAll(/^-+|-+$/g, '').toLowerCase() || 'unknown';
  const trimmed = title === undefined ? '' : title.replaceAll(/\s+/g, ' ').trim();
  return `app://desktop/${identity}/${trimmed === '' ? '' : encodeURIComponent(trimmed)}`;
}
