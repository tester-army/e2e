/**
 * What the page did on its own during an attempt: for the harness's app log,
 * console output, exceptions nothing caught, requests that failed, and
 * responses with an error status; apart from it, where the page went (a
 * navigation, a new tab, a frame loading). These are the first things to
 * read when a step fails because the app broke rather than the test.
 */

import type { BrowserContext, ConsoleMessage, Frame, Page, Request, Response } from 'playwright-core';
import type { AppLogEntry } from 'e2e/engine';

/** Console message types worth a line; `debug` and the rest are the app talking to itself. */
const CONSOLE_LEVELS: Readonly<Record<string, AppLogEntry['level']>> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  log: 'info',
  info: 'info',
};

/** Documents that are no place the app went: a fresh tab, an inline frame. */
const NO_PLACE = new Set(['about:blank', 'about:srcdoc']);

/** Where the app log tells where the page went, and what it asks the engine to tell its navigations from the app's. */
export interface NavigationLog {
  /** Takes one line saying where the page went. */
  readonly navigated: (line: string) => void;
  /** Whether a navigation of the test's page to `url` is one the engine started, which its step already tells. */
  readonly ownNavigation: (url: string) => boolean;
  /** The page the test drives; every other page is a tab the app opened. */
  readonly testPage: () => Page | undefined;
}

/** Chrome's console echo of a failed load, which the network lines already tell. */
const LOAD_ECHO = 'Failed to load resource:';

/**
 * Whether a failed request is one the browser cancelled because the page
 * moved on, not the app failing: Chromium's and Firefox's abort codes, and
 * WebKit's text, read the way Playwright reads each browser's cancellation.
 */
function isCancelled(errorText: string): boolean {
  return errorText === 'net::ERR_ABORTED' || errorText === 'NS_BINDING_ABORTED' || errorText.includes('cancelled');
}

/** Reports the context's console output, uncaught exceptions, failed requests, and navigations to `log`, from now on. */
export function installAppLog(context: BrowserContext, log: (entry: AppLogEntry) => void, navigation: NavigationLog): void {
  const report = (entry: AppLogEntry): void => {
    try {
      log(entry);
    } catch {
      // The harness's sink never fails a page event.
    }
  };
  const went = (line: string): void => {
    try {
      navigation.navigated(line);
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
    if (isCancelled(failure)) return;
    report({ source: 'network', level: 'error', text: `${requestLine(request)} ${failure}` });
  });
  context.on('response', (response) => {
    const status = response.status();
    if (status < 400 || isMissingFavicon(response)) return;
    report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: responseLine(response) });
  });
  const watch = (page: Page): void => {
    // A tab's first document is told by its opening.
    let opened = false;
    page.on('framenavigated', (frame) => {
      const tab = page !== navigation.testPage();
      if (tab && frame === page.mainFrame() && !opened && !NO_PLACE.has(frame.url())) {
        opened = true;
        return;
      }
      const line = navigationLine(page, frame, tab, navigation);
      if (line !== undefined) went(line);
    });
    // A tab the app opened (`window.open`, a `target="_blank"` link); the test stays on its own page.
    page.on('popup', (tab) => {
      const at = NO_PLACE.has(tab.url()) ? '' : ` at ${tab.url()}`;
      went(`the app opened a new tab${at}; the test stays on its page`);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on('page', watch);
}

/**
 * `navigated to /checkout`, `the new tab navigated to /help`, `frame "pay"
 * loaded /embed`: one navigation as a line, or undefined for one not worth
 * telling.
 */
function navigationLine(page: Page, frame: Frame, tab: boolean, navigation: NavigationLog): string | undefined {
  const url = frame.url();
  if (NO_PLACE.has(url) || url.startsWith('data:')) return undefined;
  if (frame === page.mainFrame()) {
    if (tab) return `the new tab navigated to ${url}`;
    if (navigation.ownNavigation(url)) return undefined;
    return `navigated to ${url}`;
  }
  const name = frame.name();
  return `frame${name === '' ? '' : ` "${name}"`} loaded ${url}`;
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
