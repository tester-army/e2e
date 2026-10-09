import { AgentError } from 'e2e/agent';
import type { Decision } from './decide.ts';
import { NONE } from './questions.ts';
/** The gates every answer passes: the selected option's probability and the provider's confidence. */
export interface Gates {
  readonly minProbability: number;
  readonly minConfidence: number;
}
/**
 * What a target question settled: the offered value, with the answer that
 * chose it when one was asked, or why the step cannot go on.
 */
export type Chosen<T> = { readonly key: string; readonly value: T; readonly answer?: Decision } | { readonly blocked: string };
/**
 * Resolves a target answer against what was offered. A lone offer needs no
 * answer: the request never asked. The model's `none`, and an answer under
 * the gates, block the step. Anything the request never offered is
 * MODEL_OUTPUT_INVALID: our validation, never the provider's text.
 */
export function pick<T>(answer: Decision | undefined, offered: ReadonlyMap<string, T>, gates: Gates, what: string, operation: string): Chosen<T> {
  if (answer === undefined) {
    const [lone] = offered;
    if (offered.size === 1 && lone !== undefined) return { key: lone[0], value: lone[1] };
    throw invalid(`The decision model returned no ${what} answer.`);
  }
  if (answer.choice === NONE) return { blocked: `The decision model chose ${operation} but no ${what} for it (${describe(answer)}).` };
  const value = offered.get(answer.choice);
  if (value === undefined) throw invalid(`The decision model chose an unavailable ${what}.`);
  if (!gated(answer, gates)) return { blocked: `The ${what} is uncertain (${describe(answer)}).` };
  return { key: answer.choice, value, answer };
}
/** What a verdict question can settle on. */
export type Verdict = 'holds' | 'fails' | 'inconclusive';
const VERDICTS: ReadonlySet<string> = new Set<Verdict>(['holds', 'fails', 'inconclusive']);
/** The verdict answer, typed, or `below gate` when it fails the gates; a verdict never offered is MODEL_OUTPUT_INVALID. */
export function verdictOf(answer: Decision | undefined, gates: Gates): Verdict | 'below gate' {
  const verdict = need(answer, 'verdict');
  if (!VERDICTS.has(verdict.choice)) throw invalid('The decision model chose an unavailable verdict.');
  return gated(verdict, gates) ? (verdict.choice as Verdict) : 'below gate';
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
export function gated(decision: Decision, gates: Gates): boolean {
  return decision.probability >= gates.minProbability && decision.confidence >= gates.minConfidence;
}
/** How an answer reads in a verdict or a turn: `p=0.950, confidence 0.930`. */
export function describe(decision: Decision): string {
  return `p=${decision.probability.toFixed(3)}, confidence ${decision.confidence.toFixed(3)}`;
}
