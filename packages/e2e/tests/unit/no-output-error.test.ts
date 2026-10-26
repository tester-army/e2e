/**
 * A structured call that ends with no parsed output fails as invalid output,
 * not a provider failure. The adapter reads the finish reason and the text
 * before the SDK's `result.output` getter throws its bare
 * `NoOutputGeneratedError`, so the error carries the raw finish reason and
 * any text the model produced. An `error` finish stays a provider failure.
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

async function generateError(model: ModelInstance): Promise<unknown> {
  return adapter(model)
    .generate(call())
    .then(
      () => {
        throw new Error('expected the empty call to throw');
      },
      (cause: unknown) => cause,
    );
}

describe('empty model output', () => {
  it('structured call: empty output on a length finish is MODEL_OUTPUT_INVALID, not MODEL_PROVIDER_FAILED', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([], 'length'));
    const error = await generateError(model);

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_OUTPUT_INVALID', category: 'test' });
    // The scripted raw spelling of `length` is `max_tokens`; seeing it in the
    // message proves the raw finish reason is what flows through.
    expect((error as Error).message).toContain('max_tokens');
  });

  it('structured call: an error finish stays MODEL_PROVIDER_FAILED', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([], 'error'));
    const error = await generateError(model);

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER_FAILED', category: 'infrastructure' });
    expect((error as Error).message).toContain('error finish (raw finish reason: error)');
  });

  it('structured call: an empty content-filter finish is MODEL_REFUSED, not MODEL_OUTPUT_INVALID', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([], 'content-filter'));
    const error = await generateError(model);

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_REFUSED', category: 'test' });
  });

  it('structured call: tool-calls with text keeps the raw text on MODEL_OUTPUT_INVALID', async () => {
    const model = createScriptedInstance('fake', 'scripted', async () =>
      scriptedResult([{ type: 'text', text: '{"a":1}' }], 'tool-calls'),
    );
    const error = await generateError(model);

    expect(isAgentError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_OUTPUT_INVALID', category: 'test' });
    expect(error).toHaveProperty('rawText', '{"a":1}');
  });
});
