import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { connectCdp } from '../../src/browser-connection.ts';
import { closeRemoteChrome, launchRemoteChrome } from '../helpers/cdp-host.ts';

/** A TCP listener exposes a numeric port rather than a pipe path. */
function isTcpAddress(value: ReturnType<Server['address']>): value is AddressInfo {
  return value !== null && typeof value !== 'string';
}

/** Binds the test's HTTP server to a free loopback port. */
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  if (!isTcpAddress(address)) throw new Error('test server has no TCP address');

  return `http://127.0.0.1:${address.port}`;
}

/** Closes HTTP connections even when an assertion fails. */
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
}

it('sends authorization during CDP discovery without adding it to page requests', async () => {
  const remote = await launchRemoteChrome();
  const handshakeHeaders: (string | undefined)[] = [];
  const pageHeaders: (string | undefined)[] = [];

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/devtools/')) {
      handshakeHeaders.push(request.headers.authorization);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: remote.endpoint }));
    } else {
      pageHeaders.push(request.headers.authorization);
      response.end('<title>Test app</title>');
    }
  });

  try {
    const url = await listen(server);
    const browser = await connectCdp(`${url}/devtools`, 5_000, { Authorization: 'Bearer synthetic-token' });

    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${url}/app`);
      expect(await page.title()).toBe('Test app');
      expect(handshakeHeaders).toEqual(['Bearer synthetic-token']);
      expect(pageHeaders.length).toBeGreaterThan(0);
      expect(pageHeaders.every((header) => header === undefined)).toBe(true);
    } finally {
      await browser.close();
    }
  } finally {
    await close(server);
    await closeRemoteChrome(remote);
  }
});

it('removes handshake secrets from real connection errors and their causes', async () => {
  const server = createServer();
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 401 Authorization Bearer synthetic-token, token synthetic-token\r\nContent-Length: 0\r\n\r\n');
  });

  try {
    const endpoint = (await listen(server)).replace('http:', 'ws:');

    try {
      await connectCdp(endpoint, 5_000, { Authorization: 'Bearer synthetic-token' });
      expect.unreachable('the server rejected the WebSocket upgrade');
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      expect(cause.message).toContain('401 Authorization [redacted], token [redacted]');
      expect(cause.stack).not.toContain('synthetic-token');
      expect(cause.cause).toBeUndefined();
    }
  } finally {
    await close(server);
  }
});
