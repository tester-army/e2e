/**
 * One tab of a launched BiDi browser, below the engine: for tests that run
 * in-page code as an oracle (the reader on its own, Chrome's accessibility
 * tree, axe's expectations) rather than drive the engine's contract.
 */

import { launchBidiBrowser, type BidiBrowser } from '../../src/driver/launch.ts';
import type { BrowserName } from '../../src/browsers.ts';
import type { BidiConnection } from '../../src/driver/connection.ts';
import { callFunction, type PageArgument, type PageFunction, type PageValue } from '../../src/driver/script.ts';
import { startPageServer, type PageServer } from './web-session.ts';

/** How to open the tab. */
export interface BidiPageOptions {
  readonly browser?: BrowserName;
  /** Script sources every document of the tab runs before its own, in order. */
  readonly preloadScripts?: readonly string[];
}

export interface BidiPage {
  readonly browser: BidiBrowser;
  readonly connection: BidiConnection;
  /** The tab's browsing context. */
  readonly context: string;
  /** The page server pages are written to. */
  readonly server: PageServer;
  /** Serves `html` at a fresh path and navigates there, resolving once it loaded. */
  setContent(html: string): Promise<void>;
  /** Navigates to `url`, resolving once it loaded. */
  goto(url: string): Promise<void>;
  /** Calls `fn` in the page with `args`, awaiting a promise it returns. */
  evaluate(fn: PageFunction, ...args: PageArgument[]): Promise<PageValue>;
  /** Sends one CDP command to the tab's target through the mapper; Chromium only. */
  cdp(method: string, params?: object): Promise<unknown>;
  /** Closes the browser and the page server. */
  close(): Promise<void>;
}

/** Launches a headless browser and opens one tab on it. */
export async function openBidiPage(options: BidiPageOptions = {}): Promise<BidiPage> {
  const server = await startPageServer();
  let browser: BidiBrowser;
  try {
    browser = await launchBidiBrowser(options.browser ?? 'chromium', { headed: false, timeoutMs: 30_000, env: process.env, signal: new AbortController().signal });
  } catch (cause) {
    await server.close();
    throw cause;
  }
  const { connection } = browser;
  const close = async () => {
    await browser.close();
    await server.close();
  };
  try {
    const { context } = await connection.send('browsingContext.create', { type: 'tab' });
    for (const source of options.preloadScripts ?? []) {
      await connection.send('script.addPreloadScript', { functionDeclaration: `() => {\n${source}\n}`, contexts: [context] });
    }
    let contentCount = 0;
    let cdpSession: string | undefined;
    const page: BidiPage = {
      browser,
      connection,
      context,
      server,
      async setContent(html) {
        contentCount += 1;
        await page.goto(server.serve(`/content-${String(contentCount)}`, html));
      },
      async goto(url) {
        await connection.send('browsingContext.navigate', { context, url, wait: 'complete' });
      },
      evaluate: (fn, ...args) => callFunction(connection, context, fn, args, { awaitPromise: true, maxObjectDepth: null }),
      async cdp(method, params = {}) {
        cdpSession ??= ((await connection.sendExtension('goog:cdp.getSession', { context })) as { session: string }).session;
        const reply = (await connection.sendExtension('goog:cdp.sendCommand', { method, params, session: cdpSession })) as { result: unknown };
        return reply.result;
      },
      close,
    };
    return page;
  } catch (cause) {
    await close();
    throw cause;
  }
}
