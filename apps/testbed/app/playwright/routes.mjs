/**
 * The routes of the tests ported from Playwright: its test assets (`assets/`,
 * copied from microsoft/playwright `tests/assets` at v1.64.1, Apache-2.0) plus
 * the few dynamic routes Playwright's test server sets per test, fixed here as
 * paths. `127.0.0.1` and `localhost` on the app's port are the two origins of
 * the cross-origin cases, and the only ones trusted.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const MAX_DELAY_MS = 30_000;
const MAX_BYTES = 16 << 20;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

/** The Playwright routes of the app on `port`: a request handler and a WebSocket upgrade handler. */
export function playwrightRoutes(port) {
  const ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  /** `value` as a number in [0, max], `fallback` when absent. */
  function bounded(value, fallback, max) {
    return Math.min(Math.max(Number(value ?? fallback) || 0, 0), max);
  }

  /** A redirect target on this server (a path, or either origin), else the empty page. */
  function sameServer(target) {
    if (target === null) return '/empty.html';
    const resolved = URL.canParse(target, `http://127.0.0.1:${port}`) ? new URL(target, `http://127.0.0.1:${port}`) : undefined;
    if (resolved === undefined || !ORIGINS.has(resolved.origin)) return '/empty.html';
    return target.startsWith('/') ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
  }

  /**
   * The request's origin when it is one of the server's own, the only ones
   * granted credentials, or `null`, the origin a cross-origin redirect leaves.
   */
  function trustedOrigin(request) {
    const { origin } = request.headers;
    if (origin === 'null') return 'null';
    return origin !== undefined && ORIGINS.has(origin) ? origin : `http://127.0.0.1:${port}`;
  }

  /** The request body, read whole. */
  function body(request) {
    return new Promise((resolve) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  const counts = new Map();
  const logs = new Map();

  /** Serves one request: a dynamic route, else an asset, else a 404. */
  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams;
    switch (url.pathname) {
      case '/content':
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(Buffer.from(query.get('html') ?? '', 'base64url'));
        return;
      case '/echo': {
        const received = await body(request);
        response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        response.end(JSON.stringify({ method: request.method, headers: request.headers, body: received.toString(), url: request.url }));
        return;
      }
      case '/status':
        response.writeHead(Number(query.get('code') ?? 200), { 'content-type': 'text/plain' });
        response.end(query.get('body') ?? '');
        return;
      case '/slow':
        setTimeout(() => {
          response.writeHead(200, { 'content-type': query.get('type') ?? 'text/plain', 'access-control-allow-origin': '*' });
          response.end(query.get('body') ?? 'slow');
        }, bounded(query.get('ms'), 1000, MAX_DELAY_MS));
        return;
      case '/never':
        request.on('close', () => response.destroy());
        return;
      case '/redirect':
        response.writeHead(302, { location: sameServer(query.get('to')) });
        response.end();
        return;
      case '/download':
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment${query.has('name') ? `; filename=${query.get('name')}` : ''}`,
        });
        response.end(query.get('body') ?? 'Hello world');
        return;
      case '/set-cookie':
        response.writeHead(200, { 'set-cookie': query.get('cookie') ?? 'name=value', 'content-type': 'text/html' });
        response.end('<title>cookie</title>');
        return;
      case '/respond':
        response.writeHead(Number(query.get('status') ?? 200), JSON.parse(query.get('headers') ?? '{}'));
        response.end(query.get('body') ?? '');
        return;
      case '/cors-echo': {
        const allow = {
          'access-control-allow-origin': trustedOrigin(request),
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'POST, GET, OPTIONS, DELETE',
          'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
        };
        if (request.method === 'OPTIONS' && query.has('preflight')) {
          response.writeHead(204, allow);
          response.end();
          return;
        }
        const received = await body(request);
        response.writeHead(200, { 'content-type': 'text/plain', ...allow });
        response.end(JSON.stringify({ method: request.method, headers: request.headers, body: received.toString(), url: request.url }));
        return;
      }
      case '/bounce': {
        const headers = {
          location: sameServer(query.get('to')),
          'access-control-allow-origin': trustedOrigin(request),
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
          ...(query.has('cookie') ? { 'set-cookie': query.get('cookie') } : {}),
        };
        if (request.method === 'OPTIONS') delete headers.location;
        response.writeHead(request.method === 'OPTIONS' ? 204 : Number(query.get('status') ?? 302), headers);
        response.end();
        return;
      }
      case '/count': {
        const key = query.get('key') ?? '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(String(counts.get(key) * 11));
        return;
      }
      case '/options': {
        const key = query.get('key') ?? '';
        logs.set(key, [...(logs.get(key) ?? []), `${request.method}:${url.pathname}`]);
        response.writeHead(200, request.method === 'OPTIONS'
          ? { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS, DELETE', 'access-control-allow-headers': '*', 'cache-control': 'no-cache' }
          : { 'access-control-allow-origin': '*' });
        response.end(request.method === 'OPTIONS' ? 'Hello' : 'World');
        return;
      }
      case '/options-log':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(logs.get(query.get('key') ?? '') ?? []));
        return;
      case '/upload': {
        const received = await body(request);
        const type = request.headers['content-type'] ?? '';
        const boundary = Buffer.from(`--${type.includes('boundary=') ? type.slice(type.indexOf('boundary=') + 'boundary='.length) : ''}`);
        const files = [];
        for (let start = received.indexOf(boundary); start !== -1;) {
          const next = received.indexOf(boundary, start + boundary.length);
          if (next === -1) break;
          const part = received.subarray(start + boundary.length + 2, next - 2);
          const split = part.indexOf('\r\n\r\n');
          const head = part.subarray(0, split).toString();
          const data = part.subarray(split + 4);
          files.push({
            name: /name="([^"]*)"/.exec(head)?.[1],
            filename: /filename="([^"]*)"/.exec(head)?.[1],
            mimetype: /content-type: (.+)/i.exec(head)?.[1],
            size: data.length,
            base64: data.length <= 65536 ? data.toString('base64') : undefined,
          });
          start = next;
        }
        response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        response.end(JSON.stringify(files));
        return;
      }
      case '/binary': {
        const data = Buffer.alloc(bounded(query.get('bytes'), 1 << 20, MAX_BYTES));
        for (let i = 0; i < data.length; i++) data[i] = Math.imul(i + 1, 2654435761) >>> 24;
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': data.length });
        response.end(data);
        return;
      }
      case '/download-stall':
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=file.txt' });
        response.write('a'.repeat(4096));
        response.write('foo');
        request.on('close', () => response.destroy());
        return;
      case '/sse':
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
        response.write('data: hello\n\n');
        request.on('close', () => response.destroy());
        return;
    }
    const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  }

  /**
   * `/ws` accepts the handshake and holds the socket open, as Playwright's
   * server does, so an open WebSocket is in the page during network-idle tests.
   */
  function upgrade(request, socket) {
    const key = request.headers['sec-websocket-key'];
    if (new URL(request.url, 'http://localhost').pathname !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.on('error', () => socket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  }

  return { handle, upgrade };
}
