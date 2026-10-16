/**
 * A model the provider does not serve to this account, as the model's own
 * constructor recognises it from the provider's answer (GitHub Copilot's
 * `model_not_supported`, for one). The constructor marks the failure with
 * the explanation a user reads; the runner reads only the mark, so no
 * vendor's codes reach the agent, and stops the run over it once instead of
 * failing test after test. The mark is a well-known symbol, so it survives
 * the package being loaded twice (a project's `e2e` beside the runner's).
 */

const UNSERVED_MODEL = Symbol.for('e2e.unserved-model.v1');

/** Marks `failure` as a model the account cannot use, with the explanation a user reads, and returns it. */
export function markUnservedModel<Failure extends Error>(failure: Failure, explanation: string): Failure {
  Object.defineProperty(failure, UNSERVED_MODEL, { value: explanation });
  return failure;
}

/** The explanation a constructor marked `failure` with, or undefined for any other failure. */
export function unservedModelExplanation(failure: unknown): string | undefined {
  if (!(failure instanceof Error)) return undefined;
  const explanation: unknown = Reflect.get(failure, UNSERVED_MODEL);
  return typeof explanation === 'string' ? explanation : undefined;
}
