/** Runner-owned query polling, strictness, and action retry (spec 08-platforms.md). */

import {
  type DriverSession,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '../driver/index.ts';
import {
  asDriverError,
  E2EError,
  TestError,
  translateDriverError as translateDriverErrorCore,
} from '../internal/errors.ts';
import { describeExpression } from './expression.ts';
import { Deadline, POLL_INTERVAL_MS, sleep } from '../internal/time.ts';

/** Canonical visibility predicate over a semantic node snapshot. */
export function isNodeVisible(node: SemanticNode | null): boolean {
  return node !== null && node.states?.hidden !== true;
}

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
    // `timeoutMs` is the budget for ONE driver operation; a polling loop owns
    // its own aggregate deadline and stops on that. So a nearly expired or
    // already expired polling deadline must not shrink a single call's budget
    // below what the backend needs: the direct-read surfaces express "do not
    // wait for a value" as an expired deadline, and an assertion's last round
    // has milliseconds left. Either way one resolve still costs whatever the
    // backend costs, which a device makes obvious where an in-process browser
    // query does not. The floor is the action budget, still capped by the
    // remaining test timeout.
    const floor = Math.min(this.options.actionTimeout, this.options.testDeadline.remaining());
    const budget = Math.max(deadline.remaining(), floor);
    return {
      signal: this.options.signal,
      timeoutMs: Math.max(1, budget),
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
        if (asDriverError(cause)?.retryable === true && !deadline.expired()) {
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
   * when given, bounds internal retries of retryable driver errors; it
   * defaults to the action timeout.
   */
  async resolveAll(
    expression: LocatorExpression,
    deadline: Deadline = this.deadline(this.options.actionTimeout),
  ): Promise<readonly NodeRef[]> {
    return this.resolveOnce(expression, deadline);
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
    const ref = assertSingle(await this.resolveOnce(expression, deadline), expression);
    if (ref === null) return { node: null, count: 0 };
    try {
      const node = await this.session.screen.read(ref, this.operationWithin(deadline));
      return { node, count: 1 };
    } catch (cause) {
      if (asDriverError(cause)?.code === 'NODE_STALE') {
        return { node: null, count: 0 };
      }
      throw translateDriverError(cause, expression);
    }
  }

  /**
   * Performs exactly one action against exactly one match. Stale nodes are
   * re-resolved while the deadline remains; a possibly committed action is
   * never repeated.
   *
   * A node the driver reports as outside the viewport is scrolled into view and
   * the action retried, which is what keeps a portable action portable: a
   * backend that scrolls as part of actionability accepts it directly, and one
   * that refuses until the node is reachable gets the same treatment here.
   * Without this the identical test passes on web and throws on mobile, and
   * `01-principles.md` does not allow a backend to change what a portable test
   * does.
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
        const driverError = asDriverError(cause);
        if (
          driverError?.code === 'NODE_STALE' &&
          driverError.retryable &&
          !deadline.expired()
        ) {
          continue;
        }
        if (
          driverError?.code === 'NOT_ACTIONABLE' &&
          !deadline.expired() &&
          (await this.scrollIntoView(ref, action, deadline))
        ) {
          continue;
        }
        throw translateDriverError(cause, expression);
      }
    }
  }

  /**
   * Brings an unreachable node into view, reporting whether it did anything.
   *
   * The check is deliberate rather than assumed from the failure: a node can be
   * unactionable for reasons scrolling cannot fix — disabled, covered, not
   * visible — and retrying those would only burn the deadline. Nothing was
   * dispatched, because actionability is checked before input, so the reference
   * is still current and can carry the scroll. `scrollIntoView` moves one
   * gesture per call by contract, so the caller's loop is what reaches a
   * distant target.
   */
  private async scrollIntoView(
    ref: NodeRef,
    action: LocatorAction,
    deadline: Deadline,
  ): Promise<boolean> {
    if (action.kind === 'scrollIntoView') return false;
    try {
      const node = await this.session.screen.read(ref, this.operationWithin(deadline));
      if (node.states?.offscreen !== true) return false;
      await this.session.screen.perform(
        ref,
        { kind: 'scrollIntoView' },
        this.operationWithin(deadline),
      );
      return true;
    } catch {
      // The original failure is the one worth reporting.
      return false;
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

/** Translates a driver error into the runner-owned public taxonomy. */
export function translateDriverError(cause: unknown, expression?: LocatorExpression): E2EError {
  const suffix = expression === undefined ? '' : `: ${describeExpression(expression)}`;
  return translateDriverErrorCore(cause, suffix);
}
