/**
 * The one-shot local HTTP server a browser login redirects back to. It
 * accepts exactly one answer for the expected state, a code or the vendor's
 * refusal, replies to the browser with a page, and hands the answer to the
 * flow. When the port is taken the flow falls back to the user pasting the
 * code, so a failure to listen is reported, not thrown.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError } from './errors.ts';

export interface CallbackServerOptions {
  readonly port: number;
  readonly path: string;
  readonly state: string;
  readonly productName: string;
}

export type CallbackAnswer = { readonly code: string } | { readonly error: string };

export interface CallbackServer {
  readonly redirectUri: string;
  /** The browser's answer; rejects with CANCELLED on the signal and TIMEOUT after `timeoutMs`. */
  waitForAnswer(signal: AbortSignal | undefined, timeoutMs: number): Promise<CallbackAnswer>;
  close(): void;
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer | undefined> {
  const host = '127.0.0.1';
  let settle: ((answer: CallbackAnswer) => void) | undefined;
  const answered = new Promise<CallbackAnswer>((resolve) => {
    settle = (answer) => {
      resolve(answer);
      settle = undefined;
    };
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${options.port}`);
    const reply = (status: number, heading: string, message: string): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderPage(options.productName, heading, message));
    };
    if (url.pathname !== options.path) return reply(404, 'Not found', 'This address is not part of the login.');
    // The state binds the answer to this attempt; anything else on the port is ignored.
    if (url.searchParams.get('state') !== options.state) return reply(400, 'Login failed', 'The state does not match this login attempt.');
    const error = url.searchParams.get('error');
    if (error !== null) {
      reply(400, 'Login failed', url.searchParams.get('error_description') ?? error);
      settle?.({ error });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      reply(400, 'Login failed', 'The redirect carried no authorization code.');
      settle?.({ error: 'invalid_callback' });
      return;
    }
    reply(200, 'Signed in', 'You can close this window and return to the terminal.');
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
    waitForAnswer: (signal, timeoutMs) =>
      new Promise<CallbackAnswer>((resolve, reject) => {
        const cancelled = () => new OAuthError('CANCELLED', 'the login was cancelled');
        if (signal?.aborted) return reject(cancelled());
        const timer = setTimeout(() => reject(new OAuthError('TIMEOUT', 'the browser did not return in time')), timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(cancelled());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        void answered.finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        });
        answered.then(resolve, reject);
      }),
    close: () => {
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
