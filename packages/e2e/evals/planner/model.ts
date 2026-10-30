/**
 * The model the planner eval's projects run with: the real model for every
 * call but the explorer's steps, which finish at once. A step's request is
 * the one offering `complete_step`; everything else (the planner's
 * structured call, its repair round, the closing assessment) reaches the
 * real model, so the eval measures the planner as a user's run calls it.
 */

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';

/** What a scripted step reports back, which the next plan reads. */
const STEP_SUMMARY = 'Walked the charter; nothing unexpected on the screens it reached.';

/** Wraps `model` so the explorer's steps are scripted and the planner's calls are real. */
export function plannerOnly(model: LanguageModelV4): LanguageModelV4 {
  let calls = 0;
  const finishStep = async (): Promise<LanguageModelV4GenerateResult> => ({
    content: [
      {
        type: 'tool-call',
        toolCallId: `planner-eval-${(calls += 1)}`,
        toolName: 'complete_step',
        input: JSON.stringify({ status: 'passed', summary: STEP_SUMMARY }),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate') {
        return (options: LanguageModelV4CallOptions) =>
          options.tools?.some((tool) => tool.name === 'complete_step') === true ? finishStep() : target.doGenerate(options);
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
