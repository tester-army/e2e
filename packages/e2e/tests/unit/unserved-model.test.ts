/** A marked provider failure is the run-stopping MODEL_UNAVAILABLE, told apart from a missing model and from any other failure; nothing here loads the AI SDK. */

import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import { isUnservedModelError, unservedModelError } from '../../src/agent/model/sdk.ts';
import { markUnservedModel, unservedModelExplanation } from '../../src/internal/unserved-model.ts';

const EXPLANATION = 'GitHub Copilot does not serve claude-haiku-4.5 to this account';

/** The error the AI SDK raises for one refused call, before any constructor looked at it. */
function refusal(): APICallError {
  return new APICallError({
    message: 'The requested model is not supported.',
    url: 'https://api.githubcopilot.com/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"code":"model_not_supported","message":"The requested model is not supported."}}',
  });
}

describe('unservedModelError', () => {
  it('turns a failure the constructor marked into MODEL_UNAVAILABLE carrying its explanation, and hands that error back as is', () => {
    const error = unservedModelError(markUnservedModel(refusal(), EXPLANATION));
    expect(error?.code).toBe('MODEL_UNAVAILABLE');
    expect(error?.message).toBe(EXPLANATION);
    expect(isUnservedModelError(error)).toBe(true);
    expect(unservedModelError(error)).toBe(error);
  });

  it('reads the attempt that failed inside a spent retry chain, but not a chain the deadline cut short', () => {
    const spent = new RetryError({ message: 'Failed after 2 attempts', reason: 'maxRetriesExceeded', errors: [refusal(), markUnservedModel(refusal(), EXPLANATION)] });
    expect(unservedModelError(spent)?.message).toBe(EXPLANATION);
    const aborted = new RetryError({ message: 'aborted', reason: 'abort', errors: [markUnservedModel(refusal(), EXPLANATION)] });
    expect(unservedModelError(aborted)).toBeUndefined();
  });

  it("leaves an unmarked failure alone, the same body included: the mark is the constructor's to give", () => {
    expect(unservedModelError(refusal())).toBeUndefined();
    expect(unservedModelError(new Error('The requested model is not supported.'))).toBeUndefined();
    expect(unservedModelExplanation(refusal())).toBeUndefined();
    expect(unservedModelExplanation('not an error')).toBeUndefined();
  });

  it('is told apart from a model that was never configured', () => {
    expect(isUnservedModelError(new AgentError('MODEL_UNAVAILABLE', 'the agent fixture requires a model'))).toBe(false);
    expect(isUnservedModelError(new Error('MODEL_UNAVAILABLE'))).toBe(false);
  });
});
