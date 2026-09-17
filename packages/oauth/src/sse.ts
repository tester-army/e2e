/**
 * Folds a server-sent-event response into the single JSON body a
 * non-streaming client expects. The OpenAI Responses stream ends in a
 * `response.completed` event whose `response` is exactly the object the
 * non-streaming endpoint returns, so that event becomes the body; a
 * `response.failed` or `error` event becomes an error body.
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
  if (!response.ok || !contentType.includes('text/event-stream')) return response;
  const text = await response.text();
  let failure: unknown;
  for (const { data } of parseSse(text)) {
    if (data === '[DONE]') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record['type'] === 'response.completed' || record['type'] === 'response.incomplete') {
      return json(200, record['response']);
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
