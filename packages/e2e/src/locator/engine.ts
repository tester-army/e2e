/** Runner-owned query polling, strictness, and action retry. */

import {
  type TargetSession,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type ViewportPoint,
} from '../engine/surface.ts';
import {
  asEngineError,
  ConfigurationError,
  E2EError,
  TestError,
  translateEngineError,
  type ErrorDetails,
} from '../internal/errors.ts';
import { requireKey } from '../internal/keys.ts';
import { describeExpression, expressionHints } from './expression.ts';
import { Deadline, POLL_INTERVAL_MS, sleep } from '../internal/time.ts';
import type { AttemptBudget } from '../run/budget.ts';

/** Canonical visibility predicate over a semantic node snapshot. */
export function isNodeVisible(node: SemanticNode | null): node is SemanticNode {
  return node !== null && node.states?.hidden !== true;
}

interface LocatorEngineOptions {
  readonly session: TargetSession;
  /** The running phase's signal and deadline, read per operation. */
  readonly budget: AttemptBudget;
  readonly runId: string;
  readonly attemptId: string;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
}

/** Per-attempt locator execution engine. */
export class LocatorEngine {
  constructor(private readonly options: LocatorEngineOptions) {}

  get session(): TargetSession {
    return this.options.session;
  }

  /** The running phase's signal: the attempt's through the body, a hook's own in teardown. */
  get signal(): AbortSignal {
    return this.options.budget.signal;
  }

  get assertionTimeout(): number {
    return this.options.assertionTimeout;
  }

  /** Builds an operation context capped by the remaining test timeout. */
  operation(timeoutMs?: number): OperationContext {
    return this.operationWithin(this.deadline(timeoutMs));
  }

  /** Deadline for one action-family operation, capped by the running phase's deadline. */
  deadline(timeoutMs?: number): Deadline {
    return Deadline.min(
      new Deadline(timeoutMs ?? this.options.actionTimeout),
      this.options.budget.deadline,
    );
  }

  private operationWithin(deadline: Deadline): OperationContext {
    return {
      signal: this.signal,
      timeoutMs: Math.max(1, deadline.remaining()),
      runId: this.options.runId,
      attemptId: this.options.attemptId,
      origin: 'test',
    };
  }

  /**
   * Refuses an action the session would refuse, before the locator is
   * resolved: an undeclared kind is `UNSUPPORTED_CAPABILITY`, a `press` key
   * outside the grammar is `INVALID_ARGUMENT`. Waiting for a node the engine
   * could never act on would report it as missing instead.
   */
  private checkAction(action: LocatorAction): void {
    if (!this.session.actions.has(action.kind)) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `the "${action.kind}" action is not available on this target: its engine declares ${
          this.session.actions.size === 0 ? 'no actions' : [...this.session.actions].join(', ')
        }`,
      );
    }
    if (action.kind === 'press') requireKey(action.key);
  }

  /** Refuses a pointer action the session would refuse: an undeclared kind is `UNSUPPORTED_CAPABILITY`. */
  private checkPointerAction(action: PointerAction): void {
    if (!this.session.pointerActions.has(action.kind)) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `the "${action.kind}" action at a point is not available on this target: its engine declares ${
          this.session.pointerActions.size === 0
            ? 'no pointer actions'
            : [...this.session.pointerActions].join(', ')
        }`,
      );
    }
  }

  /** One immediate engine resolve, retrying retryable frame misses within the deadline. */
  private async resolveOnce(
    expression: LocatorExpression,
    deadline: Deadline,
  ): Promise<readonly NodeRef[]> {
    for (;;) {
      try {
        return await this.session.locate(expression, this.operationWithin(deadline));
      } catch (cause) {
        if (asEngineError(cause)?.retryable === true && !deadline.expired()) {
          await sleep(POLL_INTERVAL_MS, this.signal);
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
    const startedMs = Date.now();
    for (;;) {
      const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
      if (ref !== null) return ref;
      if (deadline.expired()) {
        // The wait as it happened: a deadline capped by the test's remaining
        // budget waited less than the action timeout, and the report says so.
        throw new TestError(
          'LOCATOR_NOT_FOUND',
          `locator matched no nodes within ${describeExpression(expression)}`,
          { details: locatorDetails(expression, Date.now() - startedMs) },
        );
      }
      await sleep(POLL_INTERVAL_MS, this.signal);
    }
  }

  /** Immediate single resolve for direct reads: zero or multiple matches fail immediately. */
  async resolveForRead(expression: LocatorExpression): Promise<NodeRef> {
    const deadline = this.deadline(this.options.actionTimeout);
    const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
    if (ref === null) {
      throw new TestError('LOCATOR_NOT_FOUND', `locator matched no nodes: ${describeExpression(expression)}`, {
        details: locatorDetails(expression),
      });
    }
    return ref;
  }

  /**
   * Resolves all current matches once without waiting. The caller's deadline,
   * when given, bounds internal retries of retryable engine errors; it
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
        const engineError = asEngineError(cause);
        if (engineError?.code === 'NODE_STALE' && engineError.retryable && !deadline.expired()) {
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
      if (asEngineError(cause)?.code === 'NODE_STALE') {
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
    if (typeof action !== 'function') this.checkAction(action);
    await this.performUntil(expression, action, this.deadline(timeoutMs));
  }

  /** Performs one pointer action at a viewport point, with no node behind it. */
  async performAt(point: ViewportPoint, action: PointerAction, timeoutMs?: number): Promise<void> {
    this.checkPointerAction(action);
    await this.dispatchAt(point, action, this.deadline(timeoutMs));
  }

  /**
   * Performs one pointer action at an offset from the top-left corner of
   * exactly one match: the node is scrolled into view when the engine can,
   * then its box is read and the pointer dispatched at the point, with no
   * node behind the gesture. The node has to be visible with a box within
   * the deadline; one that never is fails as LOCATOR_NOT_FOUND, as `waitFor`
   * does.
   */
  async performWithin(
    expression: LocatorExpression,
    offset: ViewportPoint,
    action: PointerAction,
    timeoutMs?: number,
  ): Promise<void> {
    this.checkPointerAction(action);
    const deadline = this.deadline(timeoutMs);
    const startedMs = Date.now();
    if (this.session.actions.has('scrollIntoView')) {
      await this.performUntil(expression, { kind: 'scrollIntoView' }, deadline);
    }
    for (;;) {
      const { node } = await this.tryRead(expression, deadline);
      const rect = isNodeVisible(node) ? node.rect : undefined;
      if (rect !== undefined) {
        await this.dispatchAt({ x: rect.x + offset.x, y: rect.y + offset.y }, action, deadline);
        return;
      }
      if (deadline.expired()) {
        throw new TestError(
          'LOCATOR_NOT_FOUND',
          `locator did not become visible with a box to act within: ${describeExpression(expression)}`,
          { details: locatorDetails(expression, Date.now() - startedMs) },
        );
      }
      await sleep(POLL_INTERVAL_MS, this.signal);
    }
  }

  /** One pointer dispatch within a deadline, its engine error translated to the public taxonomy. */
  private async dispatchAt(point: ViewportPoint, action: PointerAction, deadline: Deadline): Promise<void> {
    try {
      await this.session.performAt(point, action, this.operationWithin(deadline));
    } catch (cause) {
      throw translateLocatorError(cause);
    }
  }

  /** The action retry loop of `perform`, within a deadline a caller may share across steps. */
  private async performUntil(
    expression: LocatorExpression,
    action: LocatorAction | ((deadline: Deadline) => Promise<LocatorAction>),
    deadline: Deadline,
  ): Promise<void> {
    for (;;) {
      const ref = await this.resolveExactlyOne(expression, deadline);
      const resolved = typeof action === 'function' ? await action(deadline) : action;
      try {
        await this.session.perform(ref, resolved, this.operationWithin(deadline));
        return;
      } catch (cause) {
        const engineError = asEngineError(cause);
        if (
          engineError?.code === 'NODE_STALE' &&
          engineError.retryable &&
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
      { details: { ...locatorDetails(expression), matches: refs.length } },
    );
  }
  return refs[0] ?? null;
}

/**
 * The facts of a locator failure the report keeps beside the message: the
 * locator as written, what it asked for, and how long it actually waited, in ms.
 */
function locatorDetails(expression: LocatorExpression, waitedMs?: number): ErrorDetails {
  return {
    locator: describeExpression(expression),
    ...expressionHints(expression),
    ...(waitedMs === undefined ? {} : { waitedMs }),
  };
}

/** Translates an engine error into the runner-owned public taxonomy. */
export function translateLocatorError(cause: unknown, expression?: LocatorExpression): E2EError {
  const suffix = expression === undefined ? '' : `: ${describeExpression(expression)}`;
  return translateEngineError(cause, suffix);
}
