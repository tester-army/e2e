/**
 * A provider that does not serve the configured model to this account, as
 * GitHub Copilot answers for a model the plan does not include, is a
 * configuration failure of the run, told apart from a model that was never
 * configured and from any other provider failure.
 */

import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { AgentError } from '../../src/agent/error.ts';
import { isUnservedModelError, unservedModelError } from '../../src/agent/model/sdk.ts';

const COPILOT_BODY =
  '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}';
const COPILOT = { provider: 'github-copilot.chat', modelId: 'claude-haiku-4.5' };

/** The error the AI SDK raises for one refused call: `data` is its parse of the body when the provider's schema matched. */
function refusal(options: { statusCode?: number; body?: string; parsed?: boolean } = {}): APICallError {
  const responseBody = options.body ?? COPILOT_BODY;
  return new APICallError({
    message: 'The requested model is not supported.',
    url: 'https://api.githubcopilot.com/chat/completions',
    requestBodyValues: {},
    statusCode: options.statusCode ?? 400,
    responseBody,
    ...(options.parsed === false ? {} : { data: JSON.parse(responseBody) as unknown }),
  });
}

describe('unservedModelError', () => {
  beforeAll(async () => {
    await loadAiSdk();
  });

  it("turns Copilot's model_not_supported into MODEL_UNAVAILABLE naming the model and the plan", () => {
    const error = unservedModelError(refusal(), COPILOT);
    expect(error?.code).toBe('MODEL_UNAVAILABLE');
    expect(error?.message).toBe(
      'GitHub Copilot does not serve claude-haiku-4.5 to this account: the plan does not include it, or it is turned off in Copilot settings on GitHub; npx e2e models github-copilot lists the ids, and the listing cannot see plan limits',
    );
    expect(isUnservedModelError(error)).toBe(true);
  });

  it('reads the code from the body when the SDK parsed none, and through a spent retry chain', () => {
    expect(unservedModelError(refusal({ parsed: false }), COPILOT)?.code).toBe('MODEL_UNAVAILABLE');
    const chain = new RetryError({ message: 'Failed after 2 attempts', reason: 'maxRetriesExceeded', errors: [refusal(), refusal()] });
    expect(unservedModelError(chain, COPILOT)?.code).toBe('MODEL_UNAVAILABLE');
  });

  it('reads only Copilot this way: the same body from another provider stays a provider failure', () => {
    expect(unservedModelError(refusal(), { provider: 'openai.chat', modelId: 'gpt-x' })).toBeUndefined();
    expect(unservedModelError(refusal(), undefined)).toBeUndefined();
  });

  it('leaves every other failure alone', () => {
    expect(unservedModelError(refusal({ body: '{"error":{"code":"invalid_request_error","message":"bad"}}' }), COPILOT)).toBeUndefined();
    expect(
      unservedModelError(refusal({ body: '{"error":{"code":"unsupported_api_for_model","message":"model \\"gpt-6-luna\\" is not accessible via the /chat/completions endpoint"}}' }), COPILOT),
    ).toBeUndefined();
    expect(unservedModelError(refusal({ body: 'not json', parsed: false }), COPILOT)).toBeUndefined();
    expect(unservedModelError(refusal({ statusCode: 500 }), COPILOT)).toBeUndefined();
    expect(unservedModelError(new Error('The requested model is not supported.'), COPILOT)).toBeUndefined();
  });

  it('is told apart from a model that was never configured', () => {
    expect(isUnservedModelError(new AgentError('MODEL_UNAVAILABLE', 'the agent fixture requires a model'))).toBe(false);
    expect(isUnservedModelError(new Error('MODEL_UNAVAILABLE'))).toBe(false);
  });
});
