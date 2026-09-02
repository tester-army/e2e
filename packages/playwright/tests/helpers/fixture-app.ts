/**
 * Minimal HTTP fixture for backend-level integration tests.
 *
 * Backend tests assert on the backend's own behaviour: pooling, attempt
 * lifecycle, navigation, location. so they need a reachable origin and a stable title,
 * not the runner's full multi-page fixture app.
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

const PAGES: Readonly<Record<string, string>> = { '/': HOME, '/form': FORM };

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the fixture on an ephemeral port and resolves once it is listening. */
export function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    const page = PAGES[request.url ?? '/'];
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
