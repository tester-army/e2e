import { describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { failureHint } from '../../src/agent/model/sdk.ts';

const { APICallError, RetryError } = await loadAiSdk();

function apiError(statusCode: number, message = `status ${statusCode}`): Error {
  return new APICallError({ message, url: 'https://gateway.test', requestBodyValues: {}, statusCode });
}

const REJECTED = 'the provider rejected the credential the model instance was created with: check the variable the provider package reads, or the key passed at construction';
const STATELESS = 'the provider kept no earlier turn to refer back to: leave store off in the agent providerOptions (the default), or call the provider directly instead of through a gateway';
const NOT_PERSISTED = "Item with id 'rs_0af1' not found. Items are not persisted when `store` is set to false.";

describe('failureHint', () => {
  it('names a 401 or 403, and a gateway authentication error, as a rejected credential', () => {
    expect(failureHint(apiError(401))).toBe(REJECTED);
    expect(failureHint(apiError(403))).toBe(REJECTED);
    const gatewayError = Object.assign(new Error('Unauthenticated request to AI Gateway.'), {
      name: 'GatewayAuthenticationError',
      statusCode: 401,
    });
    expect(failureHint(gatewayError)).toBe(REJECTED);
    expect(failureHint(Object.assign(new Error('Unauthorized'), { name: 'Error' }))).toBe(REJECTED);
  });

  it('names an earlier turn the provider never stored, through a spent retry chain too', () => {
    expect(failureHint(apiError(400, NOT_PERSISTED))).toBe(STATELESS);
    expect(failureHint(apiError(404, "Item with id 'rs_0af1' not found."))).toBe(STATELESS);
    const chain = new RetryError({
      message: 'Failed after 3 attempts. Last error: item not found',
      reason: 'maxRetriesExceeded',
      errors: [apiError(400, NOT_PERSISTED)],
    });
    expect(failureHint(chain)).toBe(STATELESS);
  });

  it('says nothing for other failures', () => {
    expect(failureHint(apiError(500))).toBe('');
    expect(failureHint(new Error('socket hang up'))).toBe('');
    expect(failureHint('text')).toBe('');
  });
});
