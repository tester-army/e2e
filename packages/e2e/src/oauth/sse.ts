/**
 * Folds a server-sent-event response into the single JSON body a
 * non-streaming client expects. The OpenAI Responses stream ends in a
 * `response.completed` (or `response.incomplete`, when the output was cut
 * short) event whose `response` is exactly the object the non-streaming
 * endpoint returns, so that event becomes the body; a `response.failed` or
 * `error` event becomes an error body.
 *
 * The stream is recognized by its body, not by its `content-type`: the Codex
 * backend answers with no `content-type` header at all, and a body that
 * reached the AI SDK unfolded fails there as `Invalid JSON response`. The same
 * backend sends the final event with an empty `output`, the items having gone
 * out one by one as `response.output_item.done`; those are folded back in.
 */

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/** Splits a text/event-stream body into events, tolerating either newline convention. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    events.push(event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') });
  }
  return events;
}

export async function foldResponsesStream(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || contentType.includes('application/json')) return response;
  // Read from a clone: a body that turns out not to be a stream goes back untouched, bytes and metadata alike.
  const text = await response.clone().text();
  const events = parseSse(text);
  if (events.length === 0) return response;
  await response.body?.cancel();
  let failure: unknown;
  const items = new Map<number, unknown>();
  for (const { data } of events) {
    if (data === '[DONE]') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record['type'] === 'response.output_item.done' && typeof record['output_index'] === 'number') {
      items.set(record['output_index'], record['item']);
    }
    if (record['type'] === 'response.completed' || record['type'] === 'response.incomplete') {
      return json(200, withOutput(record['response'], items));
    }
    if (record['type'] === 'response.failed') {
      const inner = record['response'] as Record<string, unknown> | undefined;
      failure = inner?.['error'] ?? { message: 'the response failed' };
    } else if (record['type'] === 'error') {
      failure = { message: record['message'] ?? 'the response failed', code: record['code'] };
    }
  }
  if (failure !== undefined) return json(400, { error: failure });
  return json(502, { error: { message: 'the stream ended without a completed response' } });
}

/** The final response with the streamed items as its `output` when the event itself carried none. */
function withOutput(response: unknown, items: ReadonlyMap<number, unknown>): unknown {
  if (typeof response !== 'object' || response === null || items.size === 0) return response;
  const record = response as Record<string, unknown>;
  if (Array.isArray(record['output']) && record['output'].length > 0) return response;
  const output = [...items.entries()].toSorted(([a], [b]) => a - b).map(([, item]) => item);
  return { ...record, output };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
