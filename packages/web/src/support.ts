/** Shared error, filename, and swipe helpers for the web engine. */

import { setTimeout } from 'node:timers/promises';
import { EngineError, withinCleanupBudget, type EngineCleanupContext, type Momentum, type ScrollDirection, type ViewportPoint, type ViewportSize } from 'e2e/engine';
import { ConfigurationError, InfrastructureError, TestError } from 'e2e/engine';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** Browser call logs may carry color codes; escape codes are noise in reports. */
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
 * The browser truncates a fractional pointer coordinate, so a point composed
 * from a fractional box (`tap({ position })` on a node at y 148.875) would
 * land on the pixel before the one asked for; it is rounded to the nearest
 * CSS pixel instead.
 */
export function nearestPixel(point: ViewportPoint): ViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/** How far one swipe scrolls across an `extent` of CSS pixels at `momentum`. */
export function swipeDistance(extent: number, momentum: Momentum): number {
  const ratio = momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5;
  return Math.round(extent * ratio);
}

/** The wheel deltas that scroll `distance` pixels toward `direction`. */
export function wheelDelta(direction: ScrollDirection, distance: number): [number, number] {
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
