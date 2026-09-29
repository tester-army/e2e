/** A bound on each provider request, so one stalled response cannot spend a whole step. */

import type { AiSdk, SdkLanguageModel } from '../ai-sdk.ts';

/**
 * Longest one provider request may go without an answer. A request past it is
 * abandoned and sent again through the SDK's transport retries: a response
 * that stalls (an open connection the provider never answers) would otherwise
 * hold the step until its own timeout, minutes of a step that needed seconds.
 * Generous, so a slow reasoning turn on a large screen still finishes.
 */
const MODEL_CALL_STALL_MS = 120_000;

/**
 * `model` with each generate request bounded by `stallMs`. A request that
 * gets no response in time is aborted, and abandoned if the provider ignores
 * the abort, and fails as a retryable provider error, so the SDK retries it with its backoff, as it does a 5xx, within
 * the caller's own timeout and retry budget. `onStall` hears of each one.
 * The caller's cancellation is not a stall and passes through as it was.
 */
export function withStallGuard(
  ai: AiSdk,
  model: SdkLanguageModel,
  onStall: (stallMs: number) => void = () => undefined,
  stallMs: number = MODEL_CALL_STALL_MS,
): SdkLanguageModel {
  return ai.wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params, model: inner }) => {
        const stall = new AbortController();
        const timer = setTimeout(() => stall.abort(), stallMs);
        const abortSignal = params.abortSignal === undefined ? stall.signal : AbortSignal.any([params.abortSignal, stall.signal]);
        const stalled = new Promise<never>((_, reject) => {
          stall.signal.addEventListener('abort', () => reject(stall.signal.reason as Error), { once: true });
        });
        const request = Promise.resolve(inner.doGenerate({ ...params, abortSignal }));
        // A provider that ignores the abort is left behind, not awaited; its late settlement has no reader.
        request.catch(() => undefined);
        try {
          return await Promise.race([request, stalled]);
        } catch (cause) {
          if (!stall.signal.aborted || params.abortSignal?.aborted === true) throw cause;
          onStall(stallMs);
          throw new ai.APICallError({
            message: `the model sent no response within ${String(stallMs / 1000)}s`,
            url: 'provider-default',
            requestBodyValues: undefined,
            isRetryable: true,
            cause,
          });
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
}
