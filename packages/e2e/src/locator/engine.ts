/** Runner-owned query polling, strictness, and action retry (spec 08-platforms.md). */

import {
  DriverError,
  type DriverSession,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '../driver/index.js';
import { E2EError, TestError } from '../internal/errors.js';
import { describeExpression } from './expression.js';
import { Deadline, sleep } from '../internal/time.js';

export const POLL_INTERVAL_MS = 100;

export interface EngineOptions {
  readonly session: DriverSession;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly attemptId: string;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
  readonly testDeadline: Deadline;
  /** Throws APP_NOT_OPEN before UI operations when nothing was opened yet. */
  readonly requireOpen: () => void;
}

/** Per-attempt locator execution engine. */
export class LocatorEngine {
  constructor(private readonly options: EngineOptions) {}

  get session(): DriverSession {
    return this.options.session;
  }

  get signal(): AbortSignal {
    return this.options.signal;
  }

  get actionTimeout(): number {
    return this.options.actionTimeout;
  }

  get assertionTimeout(): number {
    return this.options.assertionTimeout;
  }

  /** Builds an operation context capped by the remaining test timeout. */
  operation(timeoutMs?: number): OperationContext {
    const remainingTest = this.options.testDeadline.remaining();
    const budget = Math.min(timeoutMs ?? this.options.actionTimeout, remainingTest);
    return {
      signal: this.options.signal,
      timeoutMs: Math.max(1, budget),
      runId: this.options.runId,
      attemptId: this.options.attemptId,
    };
  }

  /** Deadline for one action-family operation, capped by the test deadline. */
  deadline(timeoutMs?: number): Deadline {
    return Deadline.min(
      new Deadline(timeoutMs ?? this.options.actionTimeout),
      this.options.testDeadline,
    );
  }

  private operationWithin(deadline: Deadline): OperationContext {
    return {
      signal: this.options.signal,
      timeoutMs: Math.max(1, deadline.remaining()),
      runId: this.options.runId,
      attemptId: this.options.attemptId,
    };
  }

  /** One immediate driver resolve, retrying retryable frame misses within the deadline. */
  private async resolveOnce(
    expression: LocatorExpression,
    deadline: Deadline,
  ): Promise<readonly NodeRef[]> {
    this.options.requireOpen();
    for (;;) {
      try {
        return await this.session.screen.resolve(expression, this.operationWithin(deadline));
      } catch (cause) {
        if (cause instanceof DriverError && cause.retryable && !deadline.expired()) {
          await sleep(POLL_INTERVAL_MS, this.options.signal);
          continue;
        }
        throw translateDriverError(cause, expression);
      }
    }
  }

  /**
   * Resolves exactly one match. Zero matches poll until the deadline;
   * multiple matches fail immediately with LOCATOR_AMBIGUOUS.
   */
  async resolveExactlyOne(expression: LocatorExpression, deadline: Deadline): Promise<NodeRef> {
    for (;;) {
      const refs = await this.resolveOnce(expression, deadline);
      if (refs.length === 1) return refs[0]!;
      if (refs.length > 1) {
        throw new TestError(
          'LOCATOR_AMBIGUOUS',
          `locator matched ${refs.length} nodes, expected exactly one: ${describeExpression(expression)}`,
        );
      }
      if (deadline.expired()) {
        throw new TestError(
          'LOCATOR_NOT_FOUND',
          `locator matched no nodes within ${describeExpression(expression)}`,
        );
      }
      await sleep(POLL_INTERVAL_MS, this.options.signal);
    }
  }

  /** Immediate single resolve for direct reads: zero or multiple matches fail immediately. */
  async resolveForRead(expression: LocatorExpression): Promise<NodeRef> {
    const deadline = this.deadline(this.options.actionTimeout);
    const refs = await this.resolveOnce(expression, deadline);
    if (refs.length === 0) {
      throw new TestError(
        'LOCATOR_NOT_FOUND',
        `locator matched no nodes: ${describeExpression(expression)}`,
      );
    }
    if (refs.length > 1) {
      throw new TestError(
        'LOCATOR_AMBIGUOUS',
        `locator matched ${refs.length} nodes, expected exactly one: ${describeExpression(expression)}`,
      );
    }
    return refs[0]!;
  }

  /** Resolves all current matches once without waiting. */
  async resolveAll(expression: LocatorExpression): Promise<readonly NodeRef[]> {
    return this.resolveOnce(expression, this.deadline(this.options.actionTimeout));
  }

  /** Reads one node snapshot. */
  async read(expression: LocatorExpression): Promise<SemanticNode> {
    const ref = await this.resolveForRead(expression);
    try {
      return await this.session.screen.read(ref, this.operation());
    } catch (cause) {
      throw translateDriverError(cause, expression);
    }
  }

  /** Reads one node for polling surfaces; returns null while zero matches. */
  async tryRead(
    expression: LocatorExpression,
    deadline: Deadline,
  ): Promise<{ node: SemanticNode | null; count: number }> {
    const refs = await this.resolveOnce(expression, deadline);
    if (refs.length === 0) return { node: null, count: 0 };
    if (refs.length > 1) {
      throw new TestError(
        'LOCATOR_AMBIGUOUS',
        `locator matched ${refs.length} nodes, expected exactly one: ${describeExpression(expression)}`,
      );
    }
    try {
      const node = await this.session.screen.read(refs[0]!, this.operationWithin(deadline));
      return { node, count: 1 };
    } catch (cause) {
      if (cause instanceof DriverError && cause.code === 'NODE_STALE') {
        return { node: null, count: 0 };
      }
      throw translateDriverError(cause, expression);
    }
  }

  /**
   * Performs exactly one action against exactly one match. Stale nodes are
   * re-resolved while the deadline remains; a possibly committed action is
   * never repeated.
   */
  async perform(
    expression: LocatorExpression,
    action: LocatorAction,
    timeoutMs?: number,
  ): Promise<void> {
    const deadline = this.deadline(timeoutMs);
    for (;;) {
      const ref = await this.resolveExactlyOne(expression, deadline);
      try {
        await this.session.screen.perform(ref, action, this.operationWithin(deadline));
        return;
      } catch (cause) {
        if (
          cause instanceof DriverError &&
          cause.code === 'NODE_STALE' &&
          cause.retryable &&
          !deadline.expired()
        ) {
          continue;
        }
        throw translateDriverError(cause, expression);
      }
    }
  }
}

/** Translates a driver error into the runner-owned public taxonomy. */
export function translateDriverError(cause: unknown, expression?: LocatorExpression): E2EError {
  if (cause instanceof E2EError) return cause;
  const suffix = expression === undefined ? '' : `: ${describeExpression(expression)}`;
  if (cause instanceof DriverError) {
    switch (cause.code) {
      case 'NODE_STALE':
        return new TestError('LOCATOR_NOT_FOUND', `node became stale${suffix}`, { cause });
      case 'FRAME_NOT_FOUND':
        return new TestError('LOCATOR_NOT_FOUND', `${cause.message}${suffix}`, { cause });
      case 'FRAME_AMBIGUOUS':
        return new TestError('LOCATOR_AMBIGUOUS', `${cause.message}${suffix}`, { cause });
      case 'NOT_ACTIONABLE':
        return new TestError('ACTION_FAILED', `${cause.message}${suffix}`, { cause });
      case 'ACTION_MAY_HAVE_COMMITTED':
        return new TestError('ACTION_FAILED', `${cause.message}${suffix}`, { cause });
      case 'OPERATION_TIMEOUT':
        return new TestError('ACTION_FAILED', `operation timed out${suffix}`, { cause });
      case 'CANCELLED':
        return new E2EError('infrastructure', 'CANCELLED', 'operation cancelled', { cause });
      case 'UNSUPPORTED_CAPABILITY':
        return new E2EError('configuration', 'UNSUPPORTED_CAPABILITY', cause.message, { cause });
      case 'INVALID_STATE':
        return new TestError('APP_NOT_OPEN', cause.message, { cause });
      case 'DRIVER_FAILURE':
        return new E2EError('infrastructure', 'DRIVER_FAILURE', cause.message, { cause });
    }
  }
  return new E2EError(
    'infrastructure',
    'DRIVER_FAILURE',
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
}
