/** Explicit fixture operations: open the step before running any backend code. */
import type { FixtureOperation, FixtureOperations } from '../backend/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { withAbort, withTimeout } from '../internal/time.ts';
import type { AttemptEnvironment } from './fixtures.ts';

export class FixtureRecorder {
  private readonly declared = new WeakSet<object>();

  constructor(private readonly environment: AttemptEnvironment) {}

  /**
   * The surface a factory returned, which must be one it declared through
   * `fixture`: an undeclared surface would run backend code outside any step,
   * so it is a backend authoring error, not a silently unrecorded fixture.
   */
  require<T extends object>(name: string, surface: T): T {
    if (!this.declared.has(surface)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `fixture "${name}" must be declared through context.fixture(...) so its operations are recorded`,
      );
    }
    return surface;
  }

  /** Wraps declared methods and namespaces without invoking them or guessing their return types. */
  fixture<T extends object>(name: string, surface: T, operations: FixtureOperations<T>): T {
    if (this.declared.has(surface)) return surface;
    this.declared.add(surface);
    for (const [key, definition] of Object.entries(operations)) {
      if (definition === undefined) continue;
      const api = `${name}.${key}`;
      const operation = definition as FixtureOperation;
      if (operation.kind === 'resource' || operation.kind === 'assertion') {
        const method = Reflect.get(surface, key) as (...args: unknown[]) => Promise<unknown>;
        if (typeof method !== 'function') throw new TestError('INVALID_ARGUMENT', `${api} must be a method`);
        Object.defineProperty(surface, key, {
          configurable: true,
          enumerable: true,
          value: (...args: unknown[]) => this.run(api, operation, args, () => method.apply(surface, args)),
        });
      } else {
        const descriptor = propertyDescriptor(surface, key);
        let value = descriptor?.value;
        const read = descriptor?.get?.bind(surface) ?? (() => value);
        const write = descriptor?.set?.bind(surface)
          ?? (descriptor?.writable === true ? (next: unknown) => { value = next; } : undefined);
        Object.defineProperty(surface, key, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: () => this.fixture(api, read() as object, definition as FixtureOperations<object>),
          ...(write === undefined ? {} : { set: write }),
        });
      }
    }
    return surface;
  }

  /** Executes one declared operation inside its step and cancellation boundary. */
  private run(api: string, operation: FixtureOperation, args: unknown[], body: () => Promise<unknown>): Promise<unknown> {
    const { environment } = this;
    const label = operation.label?.(...args) ?? '';
    return environment.steps.run(operation.kind, api, label, () => {
      const timeout = typeof operation.timeout === 'function' ? operation.timeout(...args) : operation.timeout;
      if (timeout !== false && timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new TestError('INVALID_ARGUMENT', `${api} timeout must be positive and finite`);
      }
      const pending = withAbort(body, environment.budget.signal, () => new TestError('CANCELLED', `${api} cancelled`));
      if (timeout === false) return pending;
      const timeoutMs = timeout ?? environment.config.actionTimeout;
      return withTimeout(pending, timeoutMs, () => new TestError('ACTION_FAILED', `${api} exceeded its timeout of ${timeoutMs}ms`));
    }, { verifies: operation.verifies ?? operation.kind === 'assertion' });
  }
}

/** Finds namespace accessors without invoking them, including those defined on a class prototype. */
function propertyDescriptor(surface: object, key: string): PropertyDescriptor | undefined {
  for (let target: object | null = surface; target !== null; target = Object.getPrototypeOf(target) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor !== undefined) return descriptor;
  }
  return undefined;
}
