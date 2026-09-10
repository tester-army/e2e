import { describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { credentialHint } from '../../src/agent/model/sdk.ts';

const { APICallError } = await loadAiSdk();

function apiError(statusCode: number): Error {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://gateway.test', requestBodyValues: {}, statusCode });
}

const REJECTED = 'the provider rejected the credential the model instance was created with: check the variable the provider package reads, or the key passed at construction';

describe('credentialHint', () => {
  it('names a 401 or 403, and a gateway authentication error, as a rejected credential', () => {
    expect(credentialHint(apiError(401))).toBe(REJECTED);
    expect(credentialHint(apiError(403))).toBe(REJECTED);
    const gatewayError = Object.assign(new Error('Unauthenticated request to AI Gateway.'), {
      name: 'GatewayAuthenticationError',
      statusCode: 401,
    });
    expect(credentialHint(gatewayError)).toBe(REJECTED);
    expect(credentialHint(Object.assign(new Error('Unauthorized'), { name: 'Error' }))).toBe(REJECTED);
  });

  it('says nothing for other failures', () => {
    expect(credentialHint(apiError(500))).toBe('');
    expect(credentialHint(new Error('socket hang up'))).toBe('');
    expect(credentialHint('text')).toBe('');
  });
});
