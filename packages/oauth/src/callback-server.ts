/**
 * The one-shot local HTTP server a browser login redirects back to. It
 * accepts exactly one authorization code for the expected state, answers the
 * browser with a page, and hands the code to the flow. When the port is taken
 * the flow falls back to the user pasting the code, so a failure to listen is
 * reported, not thrown.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly path: string;
  readonly state: string;
  readonly productName: string;
}

export interface CallbackServer {
  readonly redirectUri: string;
  /** Resolves with the code, or `null` once cancelled. */
  waitForCode(): Promise<{ code: string } | null>;
  cancel(): void;
  close(): void;
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer | undefined> {
  const host = options.host ?? '127.0.0.1';
  let settle: ((value: { code: string } | null) => void) | undefined;
  const codePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${options.port}`);
    const reply = (status: number, html: string): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    };
    if (url.pathname !== options.path) {
      reply(404, renderPage(options.productName, 'Not found', 'This address is not part of the login.'));
      return;
    }
    const error = url.searchParams.get('error');
    if (error !== null) {
      reply(400, renderPage(options.productName, 'Login failed', url.searchParams.get('error_description') ?? error));
      settle?.(null);
      return;
    }
    if (url.searchParams.get('state') !== options.state) {
      reply(400, renderPage(options.productName, 'Login failed', 'The state does not match this login attempt.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      reply(400, renderPage(options.productName, 'Login failed', 'The redirect carried no authorization code.'));
      return;
    }
    reply(200, renderPage(options.productName, 'Signed in', 'You can close this window and return to the terminal.'));
    settle?.({ code });
  });

  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(options.port, host, () => resolve(true));
  });
  if (!listening) return undefined;
  const port = (server.address() as AddressInfo).port;
  return {
    // Vendors register `localhost`, not the loopback address, as the redirect host.
    redirectUri: `http://localhost:${port}${options.path}`,
    waitForCode: () => codePromise,
    cancel: () => settle?.(null),
    close: () => {
      settle?.(null);
      server.close();
      server.closeAllConnections();
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPage(productName: string, heading: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(productName)}: ${escapeHtml(heading)}</title>
<style>
  html { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p { margin: 0; opacity: 0.75; }
</style>
</head>
<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}
