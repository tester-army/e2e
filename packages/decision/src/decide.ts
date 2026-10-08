import type { StepExecutorContext } from 'e2e';
import { AgentError, isAgentError } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import * as ai from 'ai';
import type { Experimental_DecisionState } from 'ai';
import {
  Experimental_DecisionRefusalError,
  InvalidArgumentError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  TypeValidationError,
} from 'ai';
import { missingKey } from './api-key.ts';
import type { DecisionRequest } from './questions.ts';
import type { DecisionExecutorOptions } from './types.ts';
/** Transport retries per decide call. */
const MAX_RETRIES = 3;
/**
 * The SDK's decide call, or INVALID_CONFIG when the installed `ai` predates
 * it. Read off the namespace so an older `ai` still loads this module and
 * the user gets the version to install instead of a link error.
 */
export function requireDecide(): typeof ai.experimental_decide {
  const found = (ai as Partial<typeof ai>).experimental_decide;
  if (typeof found !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', 'decisionExecutor() needs ai 7.0.134 or later; update the ai package');
  }
  return found;
}
/**
 * One gated answer: the chosen option, its probability, and the provider
 * confidence. A score answer reads its most probable level as the choice,
 * carries the probability-weighted level as `score`, and its probability
 * is the mass on the levels within half a level of that score: a spread
 * over two adjacent columns is a precise position, not an uncertain one.
 */
export interface Decision {
  readonly choice: string;
  readonly probability: number;
  readonly confidence: number;
  readonly score?: number;
}
/** One answer as the SDK returns it, before validation. */
interface RawAnswer {
  readonly type: string;
  readonly choice?: string;
  readonly score?: number;
  readonly probabilities?: Record<string, number>;
}
/**
 * Makes one decide call under the step budget and returns the answers.
 * This is the only file that touches the SDK decide API, so a rename
 * there stays a one-file change.
 */
export async function decide(
  ctx: StepExecutorContext,
  model: DecisionExecutorOptions['model'],
  request: DecisionRequest,
  providerOptions?: DecisionExecutorOptions['providerOptions'],
): Promise<Record<string, Decision>> {
  ctx.signal.throwIfAborted();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let modelId = model.modelId;
  let providerMetadata: Record<string, Record<string, unknown>> | undefined;
  let answers: Record<string, RawAnswer>;
  try {
    const screenshot = request.screenshot;
    // The screenshot rides beside the JSON state as a file part; a text-only provider rejects it before the request.
    const state: Experimental_DecisionState =
      screenshot === undefined
        ? request.state
        : [{ type: 'json', value: request.state }, { type: 'file', mediaType: screenshot.mediaType, data: screenshot.data }];
    const call = { model, state, questions: request.questions, ...(providerOptions === undefined ? {} : { providerOptions }) };
    const result = await requireDecide()({
      ...(call as unknown as Parameters<typeof ai.experimental_decide>[0]),
      // Transport retries for a rate limit or a 5xx, as the runner's own adapter has; a bad answer never retries.
      maxRetries: MAX_RETRIES,
      abortSignal: ctx.signal,
    });
    ctx.signal.throwIfAborted();
    inputTokens = result.usage.inputTokens;
    outputTokens = result.usage.outputTokens;
    modelId = result.response.modelId;
    providerMetadata = result.providerMetadata as Record<string, Record<string, unknown>> | undefined;
    answers = result.answers as Record<string, RawAnswer>;
  } catch (error) {
    throw decideError(error, ctx.signal);
  } finally {
    ctx.budgets.recordModelCall({
      provider: model.provider,
      modelId,
      startedAt,
      durationMs: performance.now() - started,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    });
  }
  const decisions: Record<string, Decision> = {};
  for (const [id, answer] of Object.entries(answers)) {
    decisions[id] = { ...selected(answer), confidence: reportedConfidence(providerMetadata, id) };
  }
  return decisions;
}
/** The chosen option and its probability; anything without a valid distribution is MODEL_OUTPUT_INVALID. */
function selected(answer: RawAnswer | undefined): { choice: string; probability: number; score?: number } {
  if (answer === undefined || answer.probabilities === undefined || (answer.type !== 'choice' && answer.type !== 'score')) {
    throw new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned an answer without a choice distribution.');
  }
  if (answer.type === 'score') {
    const score = answer.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned a score answer without a score.');
    }
    let top: { choice: string; probability: number } = { choice: '', probability: -1 };
    let nearby = 0;
    for (const [level, probability] of Object.entries(answer.probabilities)) {
      if (probability > top.probability) top = { choice: level, probability };
      if (Math.abs(Number(level) - score) <= 0.5) nearby += probability;
    }
    return { choice: top.choice, probability: Math.min(1, nearby), score };
  }
  const probability = answer.choice === undefined ? 0 : (answer.probabilities[answer.choice] ?? 0);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned a probability outside [0, 1].');
  }
  return { choice: answer.choice ?? '', probability };
}
/** Provider-reported confidence for one question, or 0 when absent. */
function reportedConfidence(metadata: Record<string, Record<string, unknown>> | undefined, id: string): number {
  for (const section of Object.values(metadata ?? {})) {
    const confidence = section['confidence'];
    if (confidence !== null && typeof confidence === 'object' && !Array.isArray(confidence)) {
      const value = (confidence as Record<string, unknown>)[id];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return 0;
}
/** Maps SDK failures onto the runner error codes without echoing provider text. */
function decideError(error: unknown, signal: AbortSignal): unknown {
  signal.throwIfAborted();
  if (isAgentError(error)) return error;
  if (LoadAPIKeyError.isInstance(error)) return missingKey('decision', error);
  if (InvalidArgumentError.isInstance(error)) return error;
  const refusedIds = refused(error);
  if (refusedIds !== undefined) {
    const which = refusedIds.length === 0 ? 'a question' : refusedIds.map((id) => JSON.stringify(id)).join(', ');
    return new AgentError('MODEL_OUTPUT_INVALID', `The decision model refused to answer ${which}.`);
  }
  if (InvalidResponseDataError.isInstance(error) || TypeValidationError.isInstance(error) || JSONParseError.isInstance(error)) {
    return new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned an invalid answer.');
  }
  return new AgentError('MODEL_PROVIDER_FAILED', 'The decision model call failed.');
}
/**
 * The question ids the decision model refused, or undefined when the error
 * is no refusal. The SDK throws its own refusal error naming them; a
 * provider that reports the refusal as an answer of the wrong type is read
 * from the rejected answers.
 */
function refused(error: unknown): readonly string[] | undefined {
  if (Experimental_DecisionRefusalError.isInstance(error)) return error.questionIds;
  if (!InvalidResponseDataError.isInstance(error)) return undefined;
  const answers = error.data;
  if (typeof answers !== 'object' || answers === null) return undefined;
  const ids = Object.entries(answers as Record<string, unknown>)
    .filter(([, answer]) => typeof answer === 'object' && answer !== null && (answer as { type?: unknown }).type === 'refusal')
    .map(([id]) => id);
  return ids.length === 0 ? undefined : ids;
}
