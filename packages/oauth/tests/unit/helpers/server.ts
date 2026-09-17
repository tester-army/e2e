import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type Handler = (request: Received, response: ServerResponse) => void | Promise<void>;

/** A local HTTP server that records every request and answers through `handler`. */
export async function startServer(handler: Handler): Promise<{ url: string; requests: Received[]; close(): Promise<void> }> {
  const requests: Received[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const received: Received = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)])),
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(received);
    await handler(received, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** A fake JWT with the given payload; signatures are never checked by the package. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}
