import { AgentError } from 'e2e/agent';
import type { Decision } from './decide.ts';
import { NONE } from './questions.ts';
/**
 * What a target question settled: the offered value the model chose with
 * its answer, or the model's `none` for the operation it was asked about.
 */
export type Pick<T> = { readonly value: T; readonly answer: Decision } | { readonly none: Decision };
/**
 * Resolves a target answer against what was offered. Anything the request
 * never offered is MODEL_OUTPUT_INVALID: our validation, never the
 * provider's text.
 */
export function pick<T>(answer: Decision | undefined, offered: ReadonlyMap<string, T>, what: string): Pick<T> {
  if (answer === undefined) throw invalid(`The decision model returned no ${what} answer.`);
  if (answer.choice === NONE) return { none: answer };
  const value = offered.get(answer.choice);
  if (value === undefined) throw invalid(`The decision model chose an unavailable ${what}.`);
  return { value, answer };
}
/** A model answer the request never offered: our validation, never the provider's text. */
export function invalid(message: string): AgentError {
  return new AgentError('MODEL_OUTPUT_INVALID', message);
}
/** Requires an answer the model returned; its absence is our bug or a broken transport. */
export function need(answer: Decision | undefined, what: string): Decision {
  if (answer === undefined) throw invalid(`The decision model returned no ${what} answer.`);
  return answer;
}
/** The gates every answer passes: the selected option's probability and the provider's confidence. */
export interface Gates {
  readonly minProbability: number;
  readonly minConfidence: number;
}
export function gated(decision: Decision, gates: Gates): boolean {
  return decision.probability >= gates.minProbability && decision.confidence >= gates.minConfidence;
}
/** How an answer reads in a verdict or a turn: `p=0.950, confidence 0.930`. */
export function describe(decision: Decision): string {
  return `p=${decision.probability.toFixed(3)}, confidence ${decision.confidence.toFixed(3)}`;
}
