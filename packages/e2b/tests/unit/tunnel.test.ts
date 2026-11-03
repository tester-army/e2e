/**
 * The loopback tunnel against a real upstream on this machine, standing in
 * for E2B's edge: every request and WebSocket upgrade reaches it with the
 * sandbox's `Host` and the traffic access token, while the client's URL
 * carries neither; a JSON link to that host leads back to the tunnel; a
 * client that goes away ends its upstream request or socket; a dead upstream
 * answers 502.
 */

import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTunnel, type Tunnel } from '../../src/tunnel.ts';

const HOST = 'localhost';
const TRAFFIC_TOKEN = 'traffic-secret';

let upstream: Server;
let port: number;
let tunnel: Tunnel;
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const upgraded: Duplex[] = [];
/** Resolves when the upstream sees the hanging request's connection close. */
let hangClosed: Promise<void> = Promise.resolve();

/** One request to the tunnel, resolving to its status, body, and response headers. */
function get(path: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${tunnel.url}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    if (req.url === '/hang') {
      hangClosed = new Promise((resolve) => res.once('close', resolve));
      return;
    }
    if (req.url === '/upload/preflight') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ uploadUrl: `http://${HOST}:${port}/upload/direct/u1?part=1`, other: `http://${HOST}.example/x` }));
      return;
    }
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100' });
      // Once the head and the first bytes are out, so the tunnel has started its answer.
      res.write('only part', () => setTimeout(() => res.socket?.destroy(), 50));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('upstream body');
  });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    upgraded.push(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  ({ port } = upstream.address() as { port: number });
  tunnel = await openTunnel({ host: HOST, trafficToken: TRAFFIC_TOKEN, port, tls: false });
});

afterAll(async () => {
  await tunnel.close();
  for (const socket of upgraded) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('tunnel', () => {
  it('listens on loopback only, with no secret in its URL', () => {
    expect(tunnel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(tunnel.url).not.toContain(TRAFFIC_TOKEN);
  });

  it('forwards a request with the sandbox host and the traffic token', async () => {
    seen.length = 0;
    const response = await get('/json/version?x=1');
    expect(response).toMatchObject({ status: 200, body: 'upstream body' });
    expect(seen).toEqual([{ path: '/json/version?x=1', headers: expect.objectContaining({ host: HOST, 'e2b-traffic-access-token': TRAFFIC_TOKEN }) }]);
    expect(JSON.stringify(response.headers)).not.toContain(TRAFFIC_TOKEN);
  });

  it('forwards a WebSocket upgrade with the same host and token', async () => {
    seen.length = 0;
    const opened = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`${tunnel.url.replace(/^http:/, 'ws:')}/devtools/browser/b1`);
      socket.addEventListener('open', () => {
        socket.close();
        resolve(true);
      });
      socket.addEventListener('error', () => resolve(false));
    });
    expect(opened).toBe(true);
    expect(seen).toEqual([{ path: '/devtools/browser/b1', headers: expect.objectContaining({ host: HOST, 'e2b-traffic-access-token': TRAFFIC_TOKEN }) }]);
  });

  it('points a JSON link to the sandbox host back at the tunnel', async () => {
    const response = await get('/upload/preflight');
    expect(JSON.parse(response.body)).toEqual({ uploadUrl: `${tunnel.url}/upload/direct/u1?part=1`, other: `http://${HOST}.example/x` });
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
  });

  it('ends the client response when the sandbox cuts its answer off midway', async () => {
    const ended = await new Promise<string>((resolve) => {
      const req = httpRequest(`${tunnel.url}/cut`, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.complete ? 'end' : 'cut'));
        res.on('error', () => resolve('error'));
        res.on('aborted', () => resolve('aborted'));
      });
      req.on('error', () => resolve('error'));
      req.end();
    });
    expect(ended).not.toBe('end');
  });

  it('ends the upstream request when the client goes away', async () => {
    const req = httpRequest(`${tunnel.url}/hang`);
    req.on('error', () => {});
    req.end();
    await expect.poll(() => seen.some((one) => one.path === '/hang')).toBe(true);
    req.destroy();
    await hangClosed;
  });

  it('ends the upstream socket when a WebSocket client goes away before it connects', async () => {
    // A TLS tunnel to a server that never answers the handshake: the upstream never connects.
    const silent = createNetServer();
    const accepted = new Promise<Socket>((resolve) => silent.once('connection', resolve));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const stuck = await openTunnel({ host: HOST, trafficToken: TRAFFIC_TOKEN, port: (silent.address() as { port: number }).port, tls: true });
    try {
      const client = netConnect(Number(new URL(stuck.url).port), '127.0.0.1');
      client.on('error', () => {});
      client.write(`GET /devtools/browser/b2 HTTP/1.1\r\nHost: 127.0.0.1:${new URL(stuck.url).port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      const peer = await accepted;
      // The TLS hello arriving means the tunnel is mid-handshake with the client attached.
      await new Promise((resolve) => peer.once('data', resolve));
      const ended = new Promise((resolve) => peer.once('close', resolve));
      client.destroy();
      await ended;
    } finally {
      await stuck.close();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('refuses a request or upgrade addressed to another host, as a rebound domain would send', async () => {
    seen.length = 0;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${tunnel.url}/json/list`, { headers: { host: `attacker.test:${new URL(tunnel.url).port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const reply = await new Promise<string>((resolve) => {
      const client = netConnect(Number(new URL(tunnel.url).port), '127.0.0.1');
      let text = '';
      client.on('data', (chunk) => (text += chunk));
      client.on('close', () => resolve(text));
      client.on('error', () => resolve(text));
      client.write('GET /devtools/browser/b3 HTTP/1.1\r\nHost: attacker.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toEqual([]);
  });

  it('survives a client that resets the connection while its upgrade is refused', async () => {
    for (let i = 0; i < 50; i++) {
      const client = netConnect(Number(new URL(tunnel.url).port), '127.0.0.1');
      client.on('error', () => {});
      client.write('GET /devtools/browser/b4 HTTP/1.1\r\nHost: attacker.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      client.resetAndDestroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await get('/json/version')).status).toBe(200);
  });

  it('closes with a WebSocket still open, ending it', async () => {
    const own = await openTunnel({ host: HOST, trafficToken: TRAFFIC_TOKEN, port, tls: false });
    const socket = new WebSocket(`${own.url.replace(/^http:/, 'ws:')}/devtools/browser/b5`);
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    const ended = new Promise((resolve) => socket.addEventListener('close', resolve));
    await own.close();
    await ended;
  });

  it('answers 502 when the sandbox port is gone', async () => {
    const dead = await openTunnel({ host: '127.0.0.1', trafficToken: TRAFFIC_TOKEN, port: 1, tls: false });
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(`${dead.url}/health`, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(response.status).toBe(502);
      expect(response.body).not.toContain(TRAFFIC_TOKEN);
    } finally {
      await dead.close();
    }
  });
});
