/**
 * The SDK's `NoOutputGeneratedError` — thrown by the `result.output` getter
 * when the model produced nothing to parse — is invalid output, not a
 * provider failure.
 */

import { describe, expect, it } from 'vitest';
import { isAgentError } from '../../src/agent/error.ts';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';
import type { ModelCall } from '../../src/agent/model/adapter.ts';
import type { ModelInstance } from '../../src/types.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

function adapter(model: ModelInstance) {
  return createModelAdapter({ provider: model.provider, id: model.modelId, model });
}

function call(): ModelCall<unknown> {
  return {
    system: 's',
    prompt: 'p',
    schemaName: 'agent-extract-2',
    schema: { type: 'object' },
    validate: (value: unknown) => ({ ok: true as const, value }),
    maxOutputTokens: 16,
    maxInputTokens: 64_000,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  };
}

describe('empty model output', () => {
  it('structured call: empty output on a length finish is MODEL_OUTPUT_INVALID, not MODEL_PROVIDER_FAILED', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([], 'length'));
    const error = await adapter(model)
      .generate(call())
      .then(
        () => {
          throw new Error('expected the empty call to throw');
        },
        (cause: unknown) => cause,
      );

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_OUTPUT_INVALID', category: 'test' });
  });
});
