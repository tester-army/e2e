/** Runner-owned query polling, strictness, and action retry (spec 08-platforms.md). */

import {
  type TargetSession,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '../backend/surface.ts';
import {
  asBackendError,
  E2EError,
  TestError,
  translateBackendError,
} from '../internal/errors.ts';
import { describeExpression } from './expression.ts';
import { Deadline, POLL_INTERVAL_MS, sleep } from '../internal/time.ts';

/** Canonical visibility predicate over a semantic node snapshot. */
export function isNodeVisible(node: SemanticNode | null): boolean {
  return node !== null && node.states?.hidden !== true;
}

interface EngineOptions {
  readonly session: TargetSession;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly attemptId: string;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
  readonly testDeadline: Deadline;
}

/** Per-attempt locator execution engine. */
export class LocatorEngine {
  constructor(private readonly options: EngineOptions) {}

  get session(): TargetSession {
    return this.options.session;
  }

  get signal(): AbortSignal {
    return this.options.signal;
  }

  get assertionTimeout(): number {
    return this.options.assertionTimeout;
  }

  /** Builds an operation context capped by the remaining test timeout. */
  operation(timeoutMs?: number): OperationContext {
    return this.operationWithin(this.deadline(timeoutMs));
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

  /** One immediate backend resolve, retrying retryable frame misses within the deadline. */
  private async resolveOnce(
    expression: LocatorExpression,
    deadline: Deadline,
  ): Promise<readonly NodeRef[]> {
    for (;;) {
      try {
        return await this.session.locate(expression, this.operationWithin(deadline));
      } catch (cause) {
        if (asBackendError(cause)?.retryable === true && !deadline.expired()) {
          await sleep(POLL_INTERVAL_MS, this.options.signal);
          continue;
        }
        throw translateLocatorError(cause, expression);
      }
    }
  }

  /**
   * Resolves exactly one match. Zero matches poll until the deadline;
   * multiple matches fail immediately with LOCATOR_AMBIGUOUS.
   */
  async resolveExactlyOne(expression: LocatorExpression, deadline: Deadline): Promise<NodeRef> {
    for (;;) {
      const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
      if (ref !== null) return ref;
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
    const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
    if (ref === null) {
      throw new TestError(
        'LOCATOR_NOT_FOUND',
        `locator matched no nodes: ${describeExpression(expression)}`,
      );
    }
    return ref;
  }

  /**
   * Resolves all current matches once without waiting. The caller's deadline,
   * when given, bounds internal retries of retryable backend errors; it
   * defaults to the action timeout.
   */
  async resolveAll(
    expression: LocatorExpression,
    deadline: Deadline = this.deadline(this.options.actionTimeout),
  ): Promise<readonly NodeRef[]> {
    return this.resolveOnce(expression, deadline);
  }

  /**
   * Reads one node snapshot. A concurrent locator can supersede the ref
   * between resolve and read; that is a repeatable race, so it re-resolves
   * while the deadline remains instead of failing the test.
   */
  async read(expression: LocatorExpression): Promise<SemanticNode> {
    const deadline = this.deadline(this.options.actionTimeout);
    for (;;) {
      const ref = await this.resolveForRead(expression);
      try {
        return await this.session.read(ref, this.operationWithin(deadline));
      } catch (cause) {
        const backendError = asBackendError(cause);
        if (backendError?.code === 'NODE_STALE' && backendError.retryable && !deadline.expired()) {
          continue;
        }
        throw translateLocatorError(cause, expression);
      }
    }
  }

  /** Reads one node for polling surfaces; returns null while zero matches. */
  async tryRead(
    expression: LocatorExpression,
    deadline: Deadline,
  ): Promise<{ node: SemanticNode | null; count: number }> {
    const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
    if (ref === null) return { node: null, count: 0 };
    try {
      const node = await this.session.read(ref, this.operationWithin(deadline));
      return { node, count: 1 };
    } catch (cause) {
      if (asBackendError(cause)?.code === 'NODE_STALE') {
        return { node: null, count: 0 };
      }
      throw translateLocatorError(cause, expression);
    }
  }

  /**
   * Performs exactly one action against exactly one match. Stale nodes are
   * re-resolved while the deadline remains; a possibly committed action is
   * never repeated. An action that itself names other nodes (dragTo) is built
   * per attempt, so its refs are re-resolved together with the source.
   */
  async perform(
    expression: LocatorExpression,
    action: LocatorAction | ((deadline: Deadline) => Promise<LocatorAction>),
    timeoutMs?: number,
  ): Promise<void> {
    const deadline = this.deadline(timeoutMs);
    for (;;) {
      const ref = await this.resolveExactlyOne(expression, deadline);
      const resolved = typeof action === 'function' ? await action(deadline) : action;
      try {
        await this.session.perform(ref, resolved, this.operationWithin(deadline));
        return;
      } catch (cause) {
        const backendError = asBackendError(cause);
        if (
          backendError?.code === 'NODE_STALE' &&
          backendError.retryable &&
          !deadline.expired()
        ) {
          continue;
        }
        throw translateLocatorError(cause, expression);
      }
    }
  }
}

/** Zero matches -> null; one -> the ref; many -> LOCATOR_AMBIGUOUS. */
function assertSingle(refs: readonly NodeRef[], expression: LocatorExpression): NodeRef | null {
  if (refs.length > 1) {
    throw new TestError(
      'LOCATOR_AMBIGUOUS',
      `locator matched ${refs.length} nodes, expected exactly one: ${describeExpression(expression)}`,
    );
  }
  return refs[0] ?? null;
}

/** Translates a backend error into the runner-owned public taxonomy. */
export function translateLocatorError(cause: unknown, expression?: LocatorExpression): E2EError {
  const suffix = expression === undefined ? '' : `: ${describeExpression(expression)}`;
  return translateBackendError(cause, suffix);
}
