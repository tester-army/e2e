/**
 * Minimal HTTP fixture for backend-level integration tests.
 *
 * Backend tests assert on the backend's own behaviour: pooling, attempt
 * lifecycle, navigation, location, state, artifacts. They need a reachable
 * origin and a few stable pages, not the runner's full multi-page fixture app.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const HOME = `<!doctype html>
<html>
<head><title>Fixture Home</title></head>
<body><h1>Home</h1></body>
</html>`;

const FORM = `<!doctype html>
<html>
<head><title>Fixture Form</title></head>
<body>
<h1>Form</h1>
<label>First <input name="first" value="alpha"></label>
<label>Second <input name="second" value="beta"></label>
<label>Third <input name="third" value="alpha"></label>
</body>
</html>`;

const LOGIN = `<!doctype html>
<html>
<head><title>Fixture Login</title></head>
<body style="margin:0;background:#fff">
<h1>Login</h1>
<label>User <input name="user" value="ada" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>
<label>Password <input type="password" name="password" style="width:200px;height:40px;background:#fff;border:1px solid #fff"></label>
</body>
</html>`;

/** Shows the stored token; `?set=<value>` stores one first. */
const STATE = `<!doctype html>
<html>
<head><title>Fixture State</title></head>
<body>
<h1 id="token">none</h1>
<script>
  const params = new URLSearchParams(location.search);
  if (params.has('set')) localStorage.setItem('token', params.get('set'));
  document.getElementById('token').textContent = localStorage.getItem('token') ?? 'none';
</script>
</body>
</html>`;

const PAGES: Readonly<Record<string, string>> = {
  '/': HOME,
  '/form': FORM,
  '/login': LOGIN,
  '/state': STATE,
};

/** Delay before `/slow` answers, long enough for a caller to cancel first. */
const SLOW_RESPONSE_MS = 5_000;

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the fixture on an ephemeral port and resolves once it is listening. */
export function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test');
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(HOME);
      }, SLOW_RESPONSE_MS);
      request.on('close', () => clearTimeout(timer));
      return;
    }
    const page = PAGES[url.pathname];
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
