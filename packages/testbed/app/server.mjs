/**
 * Playground app for dogfooding the e2e runner. No dependencies. The pages
 * live under `pages/` by group; this file serves them, the API, and the
 * cookie session.
 */

import { createServer } from 'node:http';
import { layout } from './layout.mjs';
import { pages } from './pages/index.mjs';

const PORT = Number(process.env.PORT ?? 4271);

function parseCookies(request) {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
}

/** One page's document: its content rendered for `request`, in the shared layout. */
function render(path, request = {}) {
  const { title, body } = pages[path](request);
  return layout(title, body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status, headers, body) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const html = (body) => send(200, { 'content-type': 'text/html; charset=utf-8' }, body);

  if (url.pathname === '/api/users') {
    send(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Margaret' }]),
    );
    return;
  }
  if (url.pathname === '/files/report.csv') {
    send(
      200,
      { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
      'id,name\n1,Ada\n2,Grace\n',
    );
    return;
  }
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = new URLSearchParams(body);
    if (params.get('username') === 'admin' && params.get('password') === 'admin-pass') {
      send(303, { 'set-cookie': 'session=admin; Path=/; HttpOnly', location: '/dashboard' });
    } else {
      html(render('/login', { failed: true }));
    }
    return;
  }
  if (url.pathname === '/logout') {
    send(303, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
    return;
  }
  if (url.pathname === '/dashboard') {
    const cookies = parseCookies(request);
    if (cookies.session !== 'admin') {
      send(303, { location: '/login' });
      return;
    }
    html(render('/dashboard', { user: 'admin' }));
    return;
  }

  if (!(url.pathname in pages)) {
    send(404, { 'content-type': 'text/plain' }, 'not found');
    return;
  }
  html(render(url.pathname));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`playground listening on http://127.0.0.1:${PORT}`);
});
