/** Compatibility adapter for fixture factories predating explicit operation metadata. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { TestError } from '../internal/errors.ts';
import { withTimeout } from '../internal/time.ts';
import type { AttemptEnvironment } from './fixtures.ts';
import type { StepKind, StepRecorder } from './steps.ts';

/**
 * Attributes what a fixture method records to the step that wraps the call.
 * The method runs before its step opens (that is what lets a synchronous
 * accessor stay an accessor), so anything it attaches synchronously is held
 * here and released into the step once the step exists, or into the current
 * step when the call turns out to be synchronous.
 */
interface PendingAttachments {
  readonly parentId: string | undefined;
  readonly held: (() => void)[];
  run: ((attach: () => void) => void) | undefined;
}

export class StepAttachments {
  private readonly scope = new AsyncLocalStorage<PendingAttachments>();

  constructor(private readonly steps: StepRecorder) {}

  /** Legacy continuations retain their eventual step scope, even though invocation preceded it. */
  record(attach: () => void): void {
    const pending = this.scope.getStore();
    const current = this.steps.currentStepId;
    if (pending === undefined || (current !== undefined && current !== pending.parentId)) attach();
    else if (pending.run === undefined) pending.held.push(attach);
    else pending.run(attach);
  }

  /** Holds early attachments, then binds later continuations to the scope that releases them. */
  collect(): { run: <T>(call: () => T) => T; release: () => void } {
    const pending: PendingAttachments = { parentId: this.steps.currentStepId, held: [], run: undefined };
    return {
      run: (call) => this.scope.run(pending, call),
      release: () => {
        pending.run = AsyncLocalStorage.snapshot();
        for (const attach of pending.held) pending.run(attach);
        pending.held.length = 0;
      },
    };
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Longest label a fixture argument may contribute to the report. */
const LABEL_LIMIT = 80;

/** Method names whose string argument is typed input, labelled by length only. */
const INPUT_METHODS = new Set(['type', 'fill', 'insertText']);

/**
 * Step label heuristic: the first string or pattern argument, if any. Fixture
 * arguments are report-visible by this rule; secret material travels as
 * `Secret` handles, never as strings, so it cannot land here. Typed input is
 * the exception: it is user data, so only its length is recorded.
 */
function labelFor(api: string, args: readonly unknown[]): string {
  const method = api.slice(api.lastIndexOf('.') + 1);
  if (INPUT_METHODS.has(method) && typeof args[0] === 'string') return `${args[0].length} chars`;
  for (const arg of args) {
    if (typeof arg === 'string') return arg.length > LABEL_LIMIT ? `${arg.slice(0, LABEL_LIMIT)}...` : arg;
    if (arg instanceof RegExp) return String(arg);
  }
  return '';
}

/** A call's own `timeout` option wins over the action timeout, as on Locator. */
function timeoutFor(args: readonly unknown[], fallback: number): number {
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) continue;
    const timeout = (arg as { timeout?: unknown }).timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) return timeout;
  }
  return fallback;
}

interface RecordingOptions {
  /** Dotted step-name prefix, e.g. `['gadget', 'knobs']`. */
  readonly path: readonly string[];
  readonly kind: StepKind;
  /** Whether calls are bounded by the action timeout (or their own `timeout` option). */
  readonly bounded: boolean;
}

/**
 * Wraps a contributed surface so every async method call is one recorded
 * step. Nested plain objects (namespaces such as `keyboard`) are wrapped
 * recursively with a dotted path; symbol-keyed members and synchronous
 * results pass through untouched.
 *
 * The member is invoked first and the step opens around the promise it
 * returns, which is what lets a synchronous accessor stay an accessor. A
 * synchronous throw is recorded as the failed step it would have been, and
 * anything the call attached through the context is released into that step,
 * however early in the call it happened.
 */
export function recordedSurface<T extends object>(
  surface: T,
  environment: AttemptEnvironment,
  attachments: StepAttachments,
  options: RecordingOptions,
): T {
  return new Proxy(surface, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string') return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const api = [...options.path, property].join('.');
          const collected = attachments.collect();
          let result: unknown;
          try {
            result = collected.run(() =>
              (value as (...inner: unknown[]) => unknown).apply(target, args),
            );
          } catch (cause) {
            // Recorded as the failed step it was, then rethrown as it was thrown:
            // a synchronous caller must not receive a promise in place of a throw.
            environment.steps
              .run(options.kind, api, labelFor(api, args), () => {
                collected.release();
                return Promise.reject(cause);
              })
              .catch(() => undefined);
            throw cause;
          }
          const { release } = collected;
          if (!isThenable(result)) {
            release();
            return result;
          }
          return environment.steps.run(options.kind, api, labelFor(api, args), () => {
            release();
            const pending = Promise.resolve(result);
            if (!options.bounded) return pending;
            const timeout = timeoutFor(args, environment.config.actionTimeout);
            // A call that outlives its budget is a failed action, like a
            // locator action that never became actionable; the test clock is
            // a separate matter.
            return withTimeout(
              pending,
              timeout,
              () => new TestError('ACTION_FAILED', `${api} exceeded its timeout of ${timeout}ms`),
            );
          }, { verifies: options.kind === 'assertion' });
        };
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        !isThenable(value) &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        return recordedSurface(value, environment, attachments, {
          ...options,
          path: [...options.path, property],
        });
      }
      return value;
    },
  });
}
