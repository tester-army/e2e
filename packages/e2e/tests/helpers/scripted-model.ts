/**
 * Shared chassis for scripted AI SDK model instances. The single-call fake
 * (`fake-model.ts`) and the tool-loop fake (`fake-loop-model.ts`) script
 * different surfaces; the model shell — spec version, streaming stub, usage
 * envelope — is identical and lives here once.
 */

import type { ModelInstance } from '../../src/types.ts';

/** Builds a V4-shaped scripted model instance around one doGenerate body. */
export function createScriptedInstance<Options>(
  provider: string,
  modelId: string,
  doGenerate: (options: Options) => Promise<unknown>,
): ModelInstance {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate,
    async doStream(): Promise<never> {
      throw new Error('scripted models do not stream');
    },
    // The runner duck-types model instances exactly like the AI SDK does; the
    // structural fields above are the whole contract the fakes rely on.
  } as ModelInstance;
}

/** One scripted generate result with the fixed test usage envelope, and the call warnings a provider attached. */
export function scriptedResult(
  content: readonly unknown[],
  finishReason: 'stop' | 'tool-calls',
  warnings: readonly ScriptedWarning[] = [],
): object {
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
      totalTokens: 120,
    },
    warnings,
  };
}

/** A provider call warning, as the AI SDK carries it onto `step.warnings`. */
export interface ScriptedWarning {
  readonly type: 'unsupported' | 'compatibility' | 'other';
  readonly feature?: string;
  readonly details?: string;
}
