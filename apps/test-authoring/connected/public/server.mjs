import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProfileStore } from './store.mjs';
import { initialShop, changeShop } from './shop-domain.mjs';
import { initialExpenses, changeExpenses } from './expenses-domain.mjs';

const appKind = 'shop';
const store = new ProfileStore(fileURLToPath(new URL('./.data/' + appKind + '/', import.meta.url)),
  appKind === 'shop' ? initialShop : initialExpenses, appKind === 'shop' ? changeShop : changeExpenses);
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/money.mjs', ['money.mjs', 'text/javascript; charset=utf-8']],
  ['/catalog.mjs', ['catalog.mjs', 'text/javascript; charset=utf-8']],
  ['/shop-domain.mjs', ['shop-domain.mjs', 'text/javascript; charset=utf-8']],
  ['/expenses-domain.mjs', ['expenses-domain.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const shopRoute = /^\/(?:catalog|cart|checkout(?:\/review)?|account(?:\/(?:addresses|wishlist|orders(?:\/[a-zA-Z0-9-]+)?))?|products\/[^/?]+|orders\/[a-zA-Z0-9-]+\/receipt)?$/;
const expenseRoute = /^\/(?:expenses(?:\/(?:overview|new|[a-zA-Z0-9-]+))?)?$/;

/** Reads complete UTF-8 JSON before it crosses the domain boundary. */
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.command || typeof data.command !== 'object' || Array.isArray(data.command) || typeof data.command.type !== 'string') throw new Error('Invalid operation');
  return data;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const target = request.url ?? '';
  const pathname = target.split('?')[0];
  try {
    if (pathname === '/api/state' || pathname === '/api/commands') {
      const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('demo_profile='))?.slice('demo_profile='.length);
      const profile = cookie && /^[0-9a-f-]{36}$/.test(cookie) ? cookie : randomUUID();
      if (profile !== cookie) response.setHeader('Set-Cookie', 'demo_profile=' + profile + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (pathname === '/api/state' && request.method === 'GET') response.end(JSON.stringify(await store.read(profile)));
      else if (pathname === '/api/commands' && request.method === 'POST') {
        if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) { response.writeHead(403).end(JSON.stringify({ error: 'Invalid origin' })); return; }
        response.end(JSON.stringify(await store.execute(profile, body(request))));
      } else response.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const asset = !target.includes('?') ? assets.get(pathname) : null;
    if (asset) {
      response.setHeader('Content-Type', asset[1]);
      const data = await readFile(new URL(asset[0], import.meta.url));
      response.end(request.method === 'HEAD' ? undefined : data);
      return;
    }
    if (!(appKind === 'shop' ? shopRoute : expenseRoute).test(pathname)) { response.writeHead(404).end('Not found'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(await readFile(new URL('index.html', import.meta.url)));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error.code ? 'Could not save data. Retry the operation.' : error.message }));
  }
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
