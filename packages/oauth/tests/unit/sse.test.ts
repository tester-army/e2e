import { describe, expect, it } from 'vitest';
import { foldResponsesStream } from '../../src/index.ts';
import { parseSse } from '../../src/sse.ts';

function sse(events: Array<{ event?: string; data: unknown }>, headers: Record<string, string> = { 'content-type': 'text/event-stream' }): Response {
  const text = events.map(({ event, data }) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { status: 200, headers });
}

const completed = { id: 'resp_1', object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1, output_tokens: 2 } };

describe('foldResponsesStream', () => {
  it('returns the completed response object as JSON', async () => {
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

  it('assembles the output from the streamed items when the final event carries none', async () => {
    const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
    const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'report', arguments: '{}' };
    const folded = await foldResponsesStream(
      sse([
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 1, item: call } },
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: message } },
        { event: 'response.completed', data: { type: 'response.completed', response: { ...completed, output: [] } } },
      ]),
    );
    expect(await folded.json()).toEqual({ ...completed, output: [message, call] });
  });

  it('folds a stream the backend sent without a content-type header', async () => {
    const folded = await foldResponsesStream(
      sse([{ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } }, { event: 'response.completed', data: { type: 'response.completed', response: completed } }], {}),
    );
    expect(folded.status).toBe(200);
    expect(folded.headers.get('content-type')).toBe('application/json');
    expect(await folded.json()).toEqual(completed);
  });

  it('passes through non-stream and error responses untouched', async () => {
    const plain = new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await foldResponsesStream(plain)).toBe(plain);
    const error = new Response('nope', { status: 429, headers: { 'content-type': 'text/event-stream' } });
    expect(await foldResponsesStream(error)).toBe(error);
  });

  it('returns an untyped response with no events as it was, bytes included', async () => {
    const untyped = new Response('{"a":1}', { status: 200, headers: { 'x-request-id': 'r1' } });
    expect(await foldResponsesStream(untyped)).toBe(untyped);
    expect(await untyped.json()).toEqual({ a: 1 });
    const binary = new Response(new Uint8Array([0xff, 0x00, 0xfe]), { status: 200 });
    expect(await foldResponsesStream(binary)).toBe(binary);
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([0xff, 0x00, 0xfe]));
    const empty = new Response(null, { status: 204 });
    expect(await foldResponsesStream(empty)).toBe(empty);
  });

  it('parses CRLF streams and multi-line data', () => {
    expect(parseSse('event: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: {"b":1}\r\n\r\n')).toEqual([{ event: 'a', data: '1\n2' }, { data: '{"b":1}' }]);
  });
});
