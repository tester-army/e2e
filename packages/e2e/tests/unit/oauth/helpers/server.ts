import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { CREDENTIALS_ENV } from '../../../../src/oauth/store.ts';
import type { OAuthCredentials } from '../../../../src/oauth/types.ts';

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

/** A fake vendor that echoes what it was sent. */
export async function echoUpstream(input: string | URL | Request): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input);
  return new Response(JSON.stringify({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.text() }));
}

export interface Echo {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const realFetch = globalThis.fetch;

/**
 * Puts a local server in a vendor's place for a constructor test: `logins`
 * is what `E2E_OAUTH_CREDENTIALS` supplies, and every request the process
 * sends reaches `vendor` with its path and query kept, whatever host it
 * named. Both stand-ins are undone after each test.
 */
export function useVendor(afterEach: (fn: () => void) => void) {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  return (vendor: { url: string }, logins: Record<string, OAuthCredentials>): void => {
    vi.stubEnv(CREDENTIALS_ENV, JSON.stringify(logins));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      return realFetch(new URL(`${url.pathname}${url.search}`, vendor.url), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(body === undefined ? {} : { body }),
      });
    });
  };
}
