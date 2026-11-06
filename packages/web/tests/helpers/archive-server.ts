import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/** A route's answer: a body served with 200, or a handler that answers itself. */
export type Route = Buffer | ((request: IncomingMessage, response: ServerResponse) => void);

/** A local HTTP server serving archives by path, recording every request it gets. */
export interface ArchiveServer {
  /** `http://127.0.0.1:<port>`, usable as `E2E_BROWSERS_DOWNLOAD_HOST`. */
  readonly origin: string;
  /** The paths requested so far, in order. */
  readonly requests: string[];
  /** Serves `route` at `path`; a path with no route answers 404. */
  route(path: string, route: Route): void;
  close(): Promise<void>;
}

/** The SHA-256 of `data`, lowercase hex. */
export function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Starts an `ArchiveServer` on a free loopback port. */
export async function startArchiveServer(): Promise<ArchiveServer> {
  const routes = new Map<string, Route>();
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    requests.push(path);
    const route = routes.get(path);
    if (route === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    if (typeof route === 'function') {
      route(request, response);
      return;
    }
    response.writeHead(200, { 'content-length': String(route.length) }).end(route);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    route: (path, route) => routes.set(path, route),
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
