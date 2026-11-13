/** A model constructor's mark on a provider failure meaning the account cannot use the model, with the explanation a user reads; a well-known symbol, so it survives two loaded copies of the package. */

const UNSERVED_MODEL = Symbol.for('e2e.unserved-model.v1');

/** Marks `failure` as a model the account cannot use, with the explanation a user reads, and returns it. */
export function markUnservedModel<Failure extends Error>(failure: Failure, explanation: string): Failure {
  Object.defineProperty(failure, UNSERVED_MODEL, { value: explanation });
  return failure;
}

/** The explanation `failure`, or the last attempt of its spent retry chain, was marked with; read by shape, before any SDK loaded. */
export function unservedModelExplanation(failure: unknown): string | undefined {
  const attempt = lastAttempt(failure);
  if (!(attempt instanceof Error)) return undefined;
  const explanation: unknown = Reflect.get(attempt, UNSERVED_MODEL);
  return typeof explanation === 'string' ? explanation : undefined;
}

/** The last attempt of a spent retry chain, else `failure` itself; a chain the deadline cut short stays whole. */
function lastAttempt(failure: unknown): unknown {
  if (!(failure instanceof Error) || failure.name !== 'AI_RetryError') return failure;
  const chain = failure as { reason?: unknown; lastError?: unknown };
  return chain.reason !== 'abort' && chain.lastError !== undefined ? chain.lastError : failure;
}
