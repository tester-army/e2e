/**
 * The multi-page fixture app integration tests run against, served over HTTP.
 * The pages live under `fixture-pages/` by theme; this file is the server: the
 * route table, the patterned paths, the non-HTML responders, and the state one
 * app keeps for its lifetime.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CANVAS_PAGES } from './fixture-pages/canvas.ts';
import { FORM_PAGES } from './fixture-pages/forms.ts';
import { FRAME_PAGES } from './fixture-pages/frames.ts';
import { GESTURE_PAGES } from './fixture-pages/gestures.ts';
import { HOME_PAGES } from './fixture-pages/home.ts';
import { LIVE_PAGES } from './fixture-pages/live.ts';
import type { FixtureState, PageRenderer } from './fixture-pages/page.ts';
import { RECORD_PAGES, renderCompany, renderRecord } from './fixture-pages/records.ts';

export interface FixtureApp {
  readonly url: string;
  /**
   * Renders every page as `variant` from now on, as `?variant=` does for one
   * request: the screen changes under a recording while its URL, which the
   * replay cache compares query and all, stays the one the recording saw.
   */
  setVariant(variant: string | null): void;
  close(): Promise<void>;
}

/** Every page served at an exact path. */
const ROUTES: Record<string, PageRenderer> = {
  ...HOME_PAGES,
  ...FRAME_PAGES,
  ...CANVAS_PAGES,
  ...FORM_PAGES,
  ...GESTURE_PAGES,
  ...LIVE_PAGES,
  ...RECORD_PAGES,
};

/** Pages whose path carries an id or a name. */
const PATTERNS: readonly { readonly pattern: RegExp; readonly render: (match: RegExpExecArray, url: URL) => string }[] = [
  {
    pattern: /^\/(records|drafts)\/([^/]+)$/,
    render: (match, url) => renderRecord(match[1] === 'records' ? 'Record' : 'Draft', decodeURIComponent(match[2]!), url.searchParams.get('variant')),
  },
  {
    pattern: /^\/companies\/([^/]+)$/,
    render: (match) => renderCompany(decodeURIComponent(match[1]!)),
  },
];

type Responder = (request: IncomingMessage, response: ServerResponse, state: FixtureState) => void;

/**
 * The basic-auth user a request carries, or undefined once a challenge was
 * answered in its place: the echo pages show only to a request with
 * credentials, as a protected preview does.
 */
function basicAuthUser(request: IncomingMessage, response: ServerResponse): { username: string; password: string } | undefined {
  const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
  const decoded = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/plain' });
    response.end('unauthorized');
    return undefined;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Everything that is not a page: the todo API, a download, a JSON endpoint, a basic-auth echo, and a request that never answers. */
const RESPONDERS: Record<string, Responder> = {
  '/api/todos': (request, response, state) => {
    if (request.method !== 'POST') {
      notFound(response);
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const todo = Buffer.concat(chunks).toString('utf8').trim();
      if (todo !== '') state.todos.add(todo);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([...state.todos]));
    });
  },
  '/report.csv': (_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="report.csv"',
    });
    response.end('id,total\n1,42\n');
  },
  '/echo.csv': (request, response) => {
    const value = new URL(request.url ?? '/', 'http://localhost').searchParams.get('value') ?? '';
    response.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="export.csv"',
    });
    response.end(`id,key\n1,${value}\n`);
  },
  // Basic auth that takes any account and echoes its password, so a suite can
  // prove the value the engine sent is redacted wherever the page shows it.
  '/basic-auth': (request, response) => {
    const decoded = basicAuthUser(request, response);
    if (decoded === undefined) return;
    html(
      response,
      `<!doctype html><title>Basic auth</title><h1>Signed in as ${escapeHtml(decoded.username)}</h1><p data-testid="echo">${escapeHtml(decoded.password)}</p>` +
        `<p data-testid="header">${escapeHtml(request.headers.authorization ?? '')}</p><a href="/basic-auth/headers.txt" download>Download headers</a>`,
    );
  },
  '/basic-auth/headers.txt': (request, response) => {
    if (basicAuthUser(request, response) === undefined) return;
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="headers.txt"' });
    response.end(`authorization: ${request.headers.authorization ?? ''}\n`);
  },
  '/api/flags': (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ betaBoard: false }));
  },
  // Never responds: exercises operation timeouts on a page that never
  // settles. The socket stays open until the client gives up.
  '/hang': () => undefined,
};

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
}

/** `text` as HTML text content, so an echoed value shows as written instead of becoming markup. */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
}

/** Answers one request from the tables above, or 404. */
function serve(request: IncomingMessage, response: ServerResponse, state: FixtureState): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (state.variant !== null && !url.searchParams.has('variant')) url.searchParams.set('variant', state.variant);
  const route = ROUTES[url.pathname];
  if (route !== undefined) {
    html(response, route(state, url));
    return;
  }
  for (const { pattern, render } of PATTERNS) {
    const match = pattern.exec(url.pathname);
    if (match !== null) {
      html(response, render(match, url));
      return;
    }
  }
  const responder = RESPONDERS[url.pathname];
  if (responder !== undefined) {
    responder(request, response, state);
    return;
  }
  notFound(response);
}

/** Starts the fixture app on an ephemeral loopback port. */
export async function startFixtureApp(): Promise<FixtureApp> {
  const state: FixtureState = { searches: 0, feedRequests: 0, todos: new Set(), variant: null };
  const server: Server = createServer((request, response) => serve(request, response, state));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setVariant: (variant) => {
      state.variant = variant;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
