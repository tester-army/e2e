import { describe, expect, it } from 'vitest';
import { foldResponsesStream } from '../../src/index.ts';
import { parseSse } from '../../src/sse.ts';

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const text = events.map(({ event, data }) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('foldResponsesStream', () => {
  it('returns the completed response object as JSON', async () => {
    const completed = { id: 'resp_1', object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1, output_tokens: 2 } };
    const folded = await foldResponsesStream(
      sse([
        { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hi' } },
        { event: 'response.completed', data: { type: 'response.completed', response: completed } },
      ]),
    );
    expect(folded.status).toBe(200);
    expect(folded.headers.get('content-type')).toBe('application/json');
    expect(await folded.json()).toEqual(completed);
  });

  it('turns a failed response into an error body', async () => {
    const folded = await foldResponsesStream(sse([{ data: { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } } }]));
    expect(folded.status).toBe(400);
    expect(await folded.json()).toEqual({ error: { code: 'rate_limit_exceeded', message: 'slow down' } });
  });

  it('reports a stream that never completes', async () => {
    const folded = await foldResponsesStream(sse([{ data: { type: 'response.created' } }, { data: '[DONE]' }]));
    expect(folded.status).toBe(502);
  });

  it('passes through non-stream and error responses untouched', async () => {
    const plain = new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await foldResponsesStream(plain)).toBe(plain);
    const error = new Response('nope', { status: 429, headers: { 'content-type': 'text/event-stream' } });
    expect(await foldResponsesStream(error)).toBe(error);
  });

  it('parses CRLF streams and multi-line data', () => {
    expect(parseSse('event: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: {"b":1}\r\n\r\n')).toEqual([{ event: 'a', data: '1\n2' }, { data: '{"b":1}' }]);
  });
});
