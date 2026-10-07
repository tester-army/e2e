import type { StepExecutorContext } from 'e2e';
import { AgentError, isAgentError } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import * as ai from 'ai';
import {
  InvalidArgumentError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  TypeValidationError,
} from 'ai';
import { missingKey } from './api-key.ts';
import type { DecisionRequest } from './questions.ts';
import type { DecisionExecutorOptions } from './types.ts';
/**
 * The SDK's decide call, or INVALID_CONFIG when the installed `ai` predates
 * it. Read off the namespace so an older `ai` still loads this module and
 * the user gets the version to install instead of a link error.
 */
export function requireDecide(): typeof ai.experimental_decide {
  const found = (ai as Partial<typeof ai>).experimental_decide;
  if (typeof found !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', 'decisionExecutor() needs ai 7.0.128 or later; update the ai package');
  }
  return found;
}
/** One gated answer: the chosen option, its probability, and the provider confidence. */
export interface Decision {
  readonly choice: string;
  readonly probability: number;
  readonly confidence: number;
}
/** One answer as the SDK returns it, before validation. */
interface RawAnswer {
  readonly type: string;
  readonly choice?: string;
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
    const call = {
      model,
      state: request.state,
      questions: request.questions,
      ...(providerOptions === undefined ? {} : { providerOptions }),
    };
    const result = await requireDecide()({
      ...(call as unknown as Parameters<typeof ai.experimental_decide>[0]),
      maxRetries: 0,
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
function selected(answer: RawAnswer | undefined): { choice: string; probability: number } {
  if (answer === undefined || answer.type !== 'choice' || answer.probabilities === undefined) {
    throw new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned an answer without a choice distribution.');
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
  if (refused(error)) return new AgentError('MODEL_OUTPUT_INVALID', 'The decision model refused to answer a question.');
  if (InvalidResponseDataError.isInstance(error) || TypeValidationError.isInstance(error) || JSONParseError.isInstance(error)) {
    return new AgentError('MODEL_OUTPUT_INVALID', 'The decision model returned an invalid answer.');
  }
  return new AgentError('MODEL_PROVIDER_FAILED', 'The decision model call failed.');
}
/**
 * Whether the decision model refused a question. ai 7.0.130 throws its own
 * refusal error; 7.0.128 and 7.0.129 report the `refusal` answer as one of
 * the wrong type, so the rejected answers are checked too. Providers that
 * throw on a refusal themselves (`@ai-sdk/openai` before 4.0.86) stay
 * generic invalid output.
 */
function refused(error: unknown): boolean {
  const RefusalError = (ai as Partial<typeof ai>).Experimental_DecisionRefusalError;
  if (RefusalError !== undefined && RefusalError.isInstance(error)) return true;
  if (!InvalidResponseDataError.isInstance(error)) return false;
  const answers = error.data;
  if (typeof answers !== 'object' || answers === null) return false;
  return Object.values(answers as Record<string, unknown>).some(
    (answer) => typeof answer === 'object' && answer !== null && (answer as { type?: unknown }).type === 'refusal',
  );
}
