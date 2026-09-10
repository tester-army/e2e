import { describe, expect, it } from 'vitest';
import { isContextOverflow } from '../../src/agent/model/overflow.ts';

describe('isContextOverflow', () => {
  it.each([
    'prompt is too long: 213462 tokens > 200000 maximum',
    '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    'Your input exceeds the context window of this model',
    "Requested token count exceeds the model's maximum context length of 131072 tokens",
    "Input length (265330) exceeds model's maximum context length (262144).",
    'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
    "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
    'Please reduce the length of the messages or completion',
    "This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens",
    'Input length 300000 exceeds the maximum allowed input length of 262144 tokens.',
    "The input (300000 tokens) is longer than the model's context length (262144 tokens).",
    'the request exceeds the available context size, try increasing it',
    'prompt token count of 200000 exceeds the limit of 128000',
    'Prompt contains 300000 tokens and 0 draft tokens, too large for model with 262144 maximum context length',
    'context_length_exceeded',
    'model_context_window_exceeded',
    'Range of input length should be [1, 129024]',
  ])('recognizes %s', (message) => {
    expect(isContextOverflow(new Error(message))).toBe(true);
  });

  it.each([
    'Rate limit reached for requests',
    'Too many requests, please retry later',
    'ThrottlingException: Too many tokens, please wait before trying again.',
    'Internal server error',
    'invalid_api_key',
    '',
  ])('does not mistake %s for an overflow', (message) => {
    expect(isContextOverflow(new Error(message))).toBe(false);
  });

  it('reads the HTTP status and the response body when the message says nothing', () => {
    expect(isContextOverflow(Object.assign(new Error('Bad Request'), { statusCode: 413 }))).toBe(true);
    expect(isContextOverflow(Object.assign(new Error('Bad Request'), { status: 413 }))).toBe(true);
    expect(isContextOverflow(Object.assign(new Error('Bad Request'), { statusCode: 400 }))).toBe(false);
    expect(
      isContextOverflow(
        Object.assign(new Error('Bad Request'), {
          statusCode: 400,
          responseBody: '{"error":{"message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
        }),
      ),
    ).toBe(true);
  });

  it('looks through wrappers: a cause chain and a spent retry chain', () => {
    const provider = new Error('prompt is too long: 250000 tokens > 200000 maximum');
    expect(isContextOverflow(new Error('gateway failed', { cause: provider }))).toBe(true);
    expect(isContextOverflow(Object.assign(new Error('Failed after 3 attempts'), { lastError: provider }))).toBe(true);
    expect(isContextOverflow(new Error('outer', { cause: new Error('middle', { cause: new Error('rate limit') }) }))).toBe(
      false,
    );
  });

  it('rejects non-errors', () => {
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow('prompt is too long')).toBe(false);
    expect(isContextOverflow(413)).toBe(false);
  });
});
