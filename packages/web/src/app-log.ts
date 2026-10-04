/**
 * What the page did on its own during an attempt, for the harness's app log:
 * console errors and warnings, exceptions nothing caught, requests that
 * failed, and responses with an error status. These are the first things to
 * read when a step fails because the app broke rather than the test.
 */

import type { BrowserContext, ConsoleMessage, Request, Response } from 'playwright-core';
import type { AppLogEntry } from 'e2e/engine';

/** Console message types worth a line: the rest is the app talking to itself. */
const CONSOLE_LEVELS: Readonly<Record<string, AppLogEntry['level']>> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
};

/** Chrome's console echo of a failed load, which the network lines already tell. */
const LOAD_ECHO = 'Failed to load resource:';

/** A request the browser cancelled because the page moved on; not the app failing. */
const ABORTED = 'net::ERR_ABORTED';

/** Reports the context's console errors, uncaught exceptions, and failed requests to `log`, from now on. */
export function installAppLog(context: BrowserContext, log: (entry: AppLogEntry) => void): void {
  const report = (entry: AppLogEntry): void => {
    try {
      log(entry);
    } catch {
      // The harness's sink never fails a page event.
    }
  };
  context.on('console', (message) => {
    const level = CONSOLE_LEVELS[message.type()];
    if (level !== undefined && !message.text().startsWith(LOAD_ECHO)) report({ source: 'console', level, text: consoleText(message) });
  });
  context.on('weberror', (webError) => {
    const error = webError.error();
    const top = error.stack?.split('\n').find((line) => line.trim().startsWith('at '))?.trim();
    report({ source: 'error', level: 'error', text: `${error.name}: ${error.message}${top === undefined ? '' : ` ${top}`}` });
  });
  context.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    if (failure === ABORTED) return;
    report({ source: 'network', level: 'error', text: `${requestLine(request)} ${failure}` });
  });
  context.on('response', (response) => {
    const status = response.status();
    if (status < 400 || isMissingFavicon(response)) return;
    report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: responseLine(response) });
  });
}

/** `message (at /app.js:12)`: the text, and where it was logged from when the browser says. */
function consoleText(message: ConsoleMessage): string {
  const { url, lineNumber } = message.location();
  return url === '' ? message.text() : `${message.text()} (at ${url}:${lineNumber + 1})`;
}

/** A browser's own request for a site icon the app never served: noise on every page of most apps. */
function isMissingFavicon(response: Response): boolean {
  return response.status() === 404 && new URL(response.url()).pathname === '/favicon.ico';
}

/** `GET https://app.test/api/todos`: the request line a network entry starts with. */
function requestLine(request: Request): string {
  return `${request.method()} ${request.url()}`;
}

/** `GET https://app.test/api/todos 500 Internal Server Error`: the request line and the status it got. */
function responseLine(response: Response): string {
  const text = response.statusText();
  return `${requestLine(response.request())} ${response.status()}${text === '' ? '' : ` ${text}`}`;
}
