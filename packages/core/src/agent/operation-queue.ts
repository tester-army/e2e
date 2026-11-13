/**
 * Call-order serialization for one step's observations and actions.
 *
 * An executor (or an AI SDK loop running parallel tool calls) that issues a
 * second action before the first settles would otherwise resolve both
 * targets against the same pre-action observation — exactly the wrong-node
 * hazard the staleness rule exists to prevent. Queued, the second call sees
 * the newest observation and a stale id fails loud instead of acting on the
 * wrong node.
 *
 * Invariant: a queued body must never enqueue another operation itself — the
 * inner call would wait behind its own caller and deadlock. Action bodies
 * call the engine session directly, secret authorization never observes, and
 * a relocation captures raw rather than through the queued observe.
 */
export class OperationQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /** Runs `body` after every operation queued before it, in call order. */
  run<T>(body: () => Promise<T>): Promise<T> {
    // The chain is always already settled-to-undefined, so failures propagate
    // to their own caller and never poison the queue.
    const run = this.chain.then(body);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
