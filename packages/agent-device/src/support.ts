/** Error translation, cancellation, and geometry helpers for the mobile driver. */

import path from 'node:path';
import { isAgentDeviceError } from 'agent-device';
import { causeMessage as message, sanitizeFilename } from 'e2e/internal';
import { DriverError, type Momentum, type ScrollDirection } from 'e2e/driver';
import type { NodeRect } from './client.ts';

/**
 * agent-device `AppError` codes that mean the requested capability does not
 * exist on this target, rather than that the operation failed.
 */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'UNSUPPORTED_OPERATION',
  'UNSUPPORTED_PLATFORM',
  'NOT_IMPLEMENTED',
]);

/** Codes that mean the session or app is not in a state the operation needs. */
const INVALID_STATE_CODES: ReadonlySet<string> = new Set([
  'APP_NOT_INSTALLED',
  'SESSION_NOT_FOUND',
]);

/**
 * Parallelism is one device per worker. A locked device almost always means
 * more workers than configured devices, so the failure says that instead of
 * surfacing the backend's bare lock message.
 */
const DEVICE_IN_USE_HINT =
  'a mobile target runs one worker per device: configure one device per worker, or set workers: 1';

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}

/**
 * Translates a backend failure at the SPI boundary.
 *
 * `committed` marks a call site that may already have delivered input to the
 * app. Such a failure is `ACTION_MAY_HAVE_COMMITTED` and never retryable,
 * because the runner must not repeat it inside the same attempt.
 */
export function translateAgentDeviceError(
  cause: unknown,
  operation: string,
  options: { readonly committed?: boolean } = {},
): DriverError {
  if (cause instanceof DriverError) return cause;
  if (options.committed === true) {
    return new DriverError(
      'ACTION_MAY_HAVE_COMMITTED',
      `${operation} failed after input may have been dispatched: ${message(cause)}`,
      { retryable: false, cause },
    );
  }
  if (isAbort(cause)) {
    return new DriverError('CANCELLED', `${operation} was cancelled`, {
      retryable: false,
      cause,
    });
  }
  if (isAgentDeviceError(cause)) {
    if (cause.code === 'DEVICE_IN_USE') {
      return new DriverError(
        'INVALID_STATE',
        `${operation}: ${message(cause)} (${DEVICE_IN_USE_HINT})`,
        { retryable: false, cause },
      );
    }
    if (UNSUPPORTED_CODES.has(cause.code)) {
      return new DriverError('UNSUPPORTED_CAPABILITY', `${operation}: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
    if (INVALID_STATE_CODES.has(cause.code)) {
      return new DriverError('INVALID_STATE', `${operation}: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }
  return new DriverError('DRIVER_FAILURE', `${operation} failed: ${message(cause)}`, {
    retryable: false,
    cause,
  });
}

/** Throws `CANCELLED` when the operation was already aborted. */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DriverError('CANCELLED', 'operation cancelled', { retryable: false });
  }
}

/** Fails a driver call that a mobile profile does not define. */
export function unsupported(what: string): DriverError {
  return new DriverError('UNSUPPORTED_CAPABILITY', `mobile-0.1 does not support ${what}`, {
    retryable: false,
  });
}

/** Fails when the app or session is not in the required state. */
export function invalidState(text: string): DriverError {
  return new DriverError('INVALID_STATE', text, { retryable: false });
}

/**
 * Races a backend promise against the operation budget and abort signal so a
 * hung daemon call cannot outlive its deadline.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  operation: { readonly signal: AbortSignal; readonly timeoutMs: number },
  label: string,
): Promise<T> {
  assertNotAborted(operation.signal);
  let timer: NodeJS.Timeout | undefined;
  // `{ once: true }` only detaches on an abort that fires. Every daemon round
  // trip shares one attempt-scoped signal, so a listener left behind by a call
  // that completed normally would accumulate for the whole test.
  let detachAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DriverError('OPERATION_TIMEOUT', `${label} exceeded its ${operation.timeoutMs} ms budget`, {
          retryable: false,
        }),
      );
    }, operation.timeoutMs);
    const onAbort = () => {
      reject(new DriverError('CANCELLED', `${label} cancelled`, { retryable: false }));
    };
    detachAbort = () => operation.signal.removeEventListener('abort', onAbort);
    operation.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detachAbort?.();
  }
}

/**
 * Explains why a capture cannot be resolved against, or undefined when it can.
 *
 * The backend reports its own verdict, and a degraded capture is not a cosmetic
 * problem: its fallback mode returns a tree whose nodes have no names, so every
 * query silently misses and the failure surfaces as a screen that is not there.
 * A truncated capture is the same hazard with a different cause: the node budget
 * cut the tree, so an absent node proves nothing.
 */
export function describeUnusableCapture(result: {
  readonly snapshotQuality?:
    | { readonly state?: string; readonly backend?: string; readonly reason?: string }
    | undefined;
  readonly truncated?: boolean | undefined;
  readonly nodes: readonly unknown[];
}): string | undefined {
  if (result.nodes.length === 0) return 'it contains no nodes';
  const quality = result.snapshotQuality;
  if (quality?.state === 'sparse') {
    const detail = quality.reason ?? `backend ${quality.backend ?? 'unknown'}`;
    return `the backend reported a sparse tree (${detail})`;
  }
  if (result.truncated === true) return 'the node budget truncated it';
  return undefined;
}

/**
 * Resolves an artifact path beneath the attempt directory and returns it as a
 * relative POSIX path. It rejects traversal rather than writing outside the
 * attempt directory.
 */
export function containedArtifact(
  artifactsDir: string,
  filename: string,
): { readonly absolute: string; readonly relative: string } {
  const absolute = path.resolve(artifactsDir, sanitizeFilename(filename));
  const relative = path.relative(artifactsDir, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DriverError('DRIVER_FAILURE', `artifact path escapes the attempt directory`, {
      retryable: false,
    });
  }
  return { absolute, relative: relative.split(path.sep).join('/') };
}

/** Momentum-to-viewport-fraction, per spec/08-platforms.md. */
const MOMENTUM_FRACTION: Readonly<Record<Momentum, number>> = {
  none: 0.5,
  slow: 0.75,
  fast: 1.5,
};

/** Momentum-to-duration in milliseconds, per spec/08-platforms.md. */
const MOMENTUM_DURATION: Readonly<Record<Momentum, number>> = {
  none: 250,
  slow: 500,
  fast: 250,
};

/** Returns the scroll fraction and duration one momentum requests. */
export function momentumGesture(momentum: Momentum): {
  readonly amount: number;
  readonly durationMs: number;
} {
  return { amount: MOMENTUM_FRACTION[momentum], durationMs: MOMENTUM_DURATION[momentum] };
}

/**
 * Returns the start and end point of a swipe across one rect. Swipes run from
 * 75% to 25% of the relevant axis, inverted for up and left.
 */
export function swipePath(
  rect: NodeRect,
  direction: ScrollDirection,
): { readonly from: { x: number; y: number }; readonly to: { x: number; y: number } } {
  const near = (extent: number, origin: number) => origin + extent * 0.25;
  const far = (extent: number, origin: number) => origin + extent * 0.75;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  switch (direction) {
    // Scrolling down moves content up: the finger travels from far to near.
    case 'down':
      return {
        from: { x: centerX, y: far(rect.height, rect.y) },
        to: { x: centerX, y: near(rect.height, rect.y) },
      };
    case 'up':
      return {
        from: { x: centerX, y: near(rect.height, rect.y) },
        to: { x: centerX, y: far(rect.height, rect.y) },
      };
    case 'right':
      return {
        from: { x: far(rect.width, rect.x), y: centerY },
        to: { x: near(rect.width, rect.x), y: centerY },
      };
    case 'left':
      return {
        from: { x: near(rect.width, rect.x), y: centerY },
        to: { x: far(rect.width, rect.x), y: centerY },
      };
  }
}

/** Center point of a rect, where a coordinate action dispatches. */
export function rectCenter(rect: NodeRect): { readonly x: number; readonly y: number } {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}
