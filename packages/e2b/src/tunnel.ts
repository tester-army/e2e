/**
 * A loopback proxy on the runner's machine to one port of one sandbox. The
 * providers create every sandbox with public traffic off, so E2B refuses any
 * request to a sandbox port without the sandbox's traffic access token in a
 * header. The web engine connects with a CDP URL alone, and agent-device's
 * client has no option for a custom header, so both talk to this proxy
 * instead, and it adds the token. A lease carries only the proxy's `127.0.0.1` URL, so the
 * traffic token reaches no lease, log line, or error the engine reports. It answers only requests
 * addressed to that URL.
 */

import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { pipeline, type Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

/** The header E2B's edge reads a sandbox's traffic access token from. */
const TRAFFIC_TOKEN_HEADER = 'e2b-traffic-access-token';

export interface TunnelTarget {
  /** The sandbox port's public host, without the scheme. */
  readonly host: string;
  /** The sandbox's traffic access token. */
  readonly trafficToken: string;
  /** Port and scheme of the public host: 443 over TLS unless a test says otherwise. */
  readonly port?: number | undefined;
  readonly tls?: boolean | undefined;
}

export interface Tunnel {
  /** `http://127.0.0.1:<port>`: the base URL that reaches the sandbox port. */
  readonly url: string;
  close(): Promise<void>;
}

/** The request's headers for the sandbox, with its own `Host` and the traffic token, less `proxy-connection`, which only a proxy reads. */
function forwardedHeaders(req: IncomingMessage, target: TunnelTarget): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers, host: target.host, [TRAFFIC_TOKEN_HEADER]: target.trafficToken };
  delete headers['proxy-connection'];
  return headers;
}

/** The request line and forwarded headers of `req`, as the raw HTTP/1.1 head a socket to the sandbox starts with. */
function requestHead(req: IncomingMessage, target: TunnelTarget): string {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(forwardedHeaders(req, target))) {
    // A header Node received more than once arrives as an array: one line each.
    for (const one of [value].flat()) {
      if (one !== undefined) lines.push(`${name}: ${one}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Whether `req` names the tunnel itself as its `Host`. A page in the user's browser that points its own
 * domain at 127.0.0.1 sends that domain instead. The tunnel replaces `Host` on the way out, so
 * Chromium's own check of it never sees the page's: the tunnel makes that check here.
 */
function addressedHere(req: IncomingMessage, port: number): boolean {
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
}

/**
 * Whether `answer` is JSON the tunnel can rewrite. A link in it to the sandbox's public host fails
 * without the token, as agent-device's upload preflight does: it names the `Host` it was asked on.
 */
function rewritable(answer: IncomingMessage): boolean {
  return answer.headers['content-encoding'] === undefined && /^application\/json\s*(;|$)/i.test(answer.headers['content-type'] ?? '');
}

/** Sends a JSON `answer` on with every link that matches `publicOrigin` pointed at `url` instead. */
function sendRewritten(answer: IncomingMessage, res: ServerResponse, publicOrigin: RegExp, url: string): void {
  const chunks: Buffer[] = [];
  answer.on('data', (chunk: Buffer) => chunks.push(chunk));
  answer.on('error', () => res.destroy());
  answer.on('end', () => {
    const body = Buffer.from(Buffer.concat(chunks).toString('utf8').replace(publicOrigin, url));
    const headers = { ...answer.headers, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    res.writeHead(answer.statusCode ?? 502, headers);
    res.end(body);
  });
}

/**
 * Joins two sockets: bytes flow both ways, and either one going away ends the other. Node keeps the
 * client's half open after it ends, and an upstream still in its TLS handshake would hold the piped
 * end, so the client's `end` counts as gone too.
 */
function relay(client: Duplex, upstream: Socket): void {
  client.pipe(upstream).pipe(client);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.on('close', () => upstream.destroy());
  client.on('end', () => upstream.destroy());
}

/** Opens a tunnel to one sandbox port on a free loopback port. */
export async function openTunnel(target: TunnelTarget): Promise<Tunnel> {
  const secure = target.tls ?? true;
  const port = target.port ?? (secure ? 443 : 80);
  // The whole host only, not the start of a longer one such as `<host>.example`.
  const publicOrigin = new RegExp(`https?://${target.host.replaceAll('.', '\\.')}(?::\\d+)?(?![\\w.:-])`, 'g');
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  let local = 0;
  let url = '';

  const server = createServer((req, res) => {
    if (!addressedHere(req, local)) {
      res.writeHead(403).end();
      return;
    }
    const send = secure ? httpsRequest : httpRequest;
    const upstream = send({ host: target.host, port, servername: target.host, path: req.url ?? '/', method: req.method, headers: forwardedHeaders(req, target) }, (answer) => {
      if (rewritable(answer)) {
        sendRewritten(answer, res, publicOrigin, url);
        return;
      }
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      pipeline(answer, res, () => {});
    });
    // The client went away: stop the request to the sandbox too.
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    // The upstream error names the sandbox host, never the token; the client sees only the status.
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, client: Duplex, head: Buffer) => {
    track(client);
    // Node drops the server's error handler from an upgraded socket; without one, a reset would crash the run.
    client.on('error', () => client.destroy());
    if (!addressedHere(req, local)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream: Socket = secure ? tlsConnect({ host: target.host, port, servername: target.host }) : netConnect(port, target.host);
    track(upstream);
    // The socket holds writes until it connects, so relaying starts at once.
    upstream.write(requestHead(req, target));
    if (head.length > 0) upstream.write(head);
    relay(client, upstream);
  });
  server.on('connection', track);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  // An open tunnel never keeps the process alive; a run that ends without releasing exits anyway.
  server.unref();
  local = (server.address() as { port: number }).port;
  url = `http://127.0.0.1:${local}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
