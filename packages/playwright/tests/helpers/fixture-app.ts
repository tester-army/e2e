/**
 * Minimal HTTP fixture for driver-level integration tests.
 *
 * Driver tests assert on the driver's own behaviour — pooling, session
 * lifecycle, navigation — so they need a reachable origin and a stable title,
 * not the runner's full multi-page fixture app.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const HOME = `<!doctype html>
<html>
<head><title>Fixture Home</title></head>
<body><h1>Home</h1></body>
</html>`;

export interface FixtureApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts the fixture on an ephemeral port and resolves once it is listening. */
export function startFixtureApp(): Promise<FixtureApp> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/' || request.url === undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(HOME);
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
