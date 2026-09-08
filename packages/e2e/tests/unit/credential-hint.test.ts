import { describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { credentialHint, instantiateLanguageModel } from '../../src/agent/model/sdk.ts';
import type { ResolvedModel } from '../../src/config/agent.ts';

const { APICallError } = await loadAiSdk();

function apiError(statusCode: number): Error {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://gateway.test', requestBodyValues: {}, statusCode });
}

const GATEWAY_MODEL: ResolvedModel = {
  kind: 'gateway',
  provider: 'anthropic',
  id: 'claude',
  endpoint: undefined,
  apiKeyEnv: 'MY_KEY',
  apiKeySource: 'MY_KEY',
  apiKey: 'x',
};
const INSTANCE_MODEL = { kind: 'instance', provider: 'openai', id: 'gpt', model: {} } as unknown as ResolvedModel;
const REJECTED = 'check that the key is complete and belongs to the AI Gateway (https://vercel.com/docs/ai-gateway)';

describe('credentialHint', () => {
  it('names the variable the credential came from on a 401 or 403', () => {
    expect(credentialHint(apiError(401), GATEWAY_MODEL)).toBe(`the gateway rejected the credential read from MY_KEY: ${REJECTED}`);
    expect(credentialHint(apiError(403), GATEWAY_MODEL)).toContain('read from MY_KEY');
    expect(credentialHint(apiError(401), { ...GATEWAY_MODEL, apiKeySource: 'AI_GATEWAY_API_KEY' })).toContain(
      'read from AI_GATEWAY_API_KEY',
    );
  });

  it('finds the source through the SDK model object the tool loop holds', () => {
    const fallback = instantiateLanguageModel({ ...GATEWAY_MODEL, apiKeySource: 'AI_GATEWAY_API_KEY' });
    const custom = instantiateLanguageModel(GATEWAY_MODEL);
    const gatewayError = Object.assign(new Error('Unauthenticated request to AI Gateway.'), {
      name: 'GatewayAuthenticationError',
      statusCode: 401,
    });
    expect(credentialHint(gatewayError, fallback)).toContain('read from AI_GATEWAY_API_KEY');
    expect(credentialHint(gatewayError, custom)).toContain('read from MY_KEY');
    // A model the runner did not build brought its own credential.
    expect(credentialHint(gatewayError, {} as never)).toBe('the provider rejected the credential the model instance was created with');
    expect(credentialHint(Object.assign(new Error('Unauthorized'), { name: 'Error' }), 'model-id')).toContain(
      'the provider rejected the credential',
    );
  });

  it('says nothing for other failures and blames the instance for an instance model', () => {
    expect(credentialHint(apiError(500), GATEWAY_MODEL)).toBe('');
    expect(credentialHint(new Error('socket hang up'))).toBe('');
    expect(credentialHint('text')).toBe('');
    expect(credentialHint(apiError(401), INSTANCE_MODEL)).toBe('the provider rejected the credential the model instance was created with');
  });
});
