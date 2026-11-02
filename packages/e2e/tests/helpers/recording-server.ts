import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request a recording server received. */
export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type Handler = (request: Received, response: ServerResponse) => void | Promise<void>;

/**
 * A local HTTP server that records every request sent to its `url` and
 * answers through `handler`. A request that names another host is answered
 * 404 and never recorded: tools that watch for new local servers (T3 Code
 * does) probe each one as `GET /` on `localhost`, which a handler would
 * otherwise take for the next request it expects.
 */
export async function startServer(handler: Handler): Promise<{ url: string; requests: Received[]; close(): Promise<void> }> {
  const requests: Received[] = [];
  let url = '';
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(url).host) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const received: Received = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)])),
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(received);
    try {
      await handler(received, response);
    } catch (error) {
      // An assertion inside a handler must not hang the client; the rejection still fails the run.
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end();
      throw error;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
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

/** Closes every server a test started, so a failing assertion never leaks a listener into the next test. */
export function useServers(afterEach: (fn: () => Promise<void>) => void) {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  return async (handler: Handler) => {
    const server = await startServer(handler);
    servers.push(server);
    return server;
  };
}
