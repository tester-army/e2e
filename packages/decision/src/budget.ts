import type { StepExecutorContext } from 'e2e';
/** What one model call came back with: its value, the tokens it used, and the model id the response named. */
export interface Recorded<T> {
  readonly value: T;
  readonly usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined };
  readonly modelId?: string;
}
/**
 * Runs one model call against the step budget: aborted before it starts or
 * after it returns, and recorded with its timing and tokens even when it
 * throws. Errors propagate untouched for the caller to map.
 */
export async function recorded<T>(ctx: StepExecutorContext, model: { readonly provider: string; readonly modelId: string }, call: () => Promise<Recorded<T>>): Promise<T> {
  ctx.signal.throwIfAborted();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let usage: Recorded<T>['usage'] = {};
  let modelId = model.modelId;
  try {
    const result = await call();
    ctx.signal.throwIfAborted();
    usage = result.usage;
    modelId = result.modelId ?? modelId;
    return result.value;
  } finally {
    ctx.budgets.recordModelCall({
      provider: model.provider,
      modelId,
      startedAt,
      durationMs: performance.now() - started,
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    });
  }
}
