/** `attachBrowser`: the `browser` fixture and a `screen` on a Chromium that is already running, outside any test. */

import type { Screen } from 'e2e';
import type { Browser } from './browser.ts';
import { cdpSource } from './bidi/browser-source.ts';
import { createWeb } from './engine.ts';

export interface AttachBrowserOptions {
  /** The attribute `getByTestId` matches; default `data-testid`. */
  readonly testIdAttribute?: string | undefined;
  /** How long the attached session's operations may take altogether, in milliseconds; default 120000. */
  readonly timeout?: number | undefined;
  /** Cancels attaching and every operation. `close` still detaches. */
  readonly signal?: AbortSignal | undefined;
}

export interface AttachedBrowser extends AsyncDisposable {
  readonly browser: Browser;
  readonly screen: Screen;
  /** Detaches. The browser keeps running, with its tabs, cookies, and storage. */
  close(): Promise<void>;
}

/**
 * Attaches to the Chromium at `cdpEndpoint` (`http://127.0.0.1:9222`, or its
 * `ws://` DevTools URL) and drives its open tab in the default browser
 * context, with the same `browser` and `screen` a test gets. Relative URLs
 * have no base: pass `browser.goto` a full URL.
 */
export async function attachBrowser(cdpEndpoint: string, options: AttachBrowserOptions = {}): Promise<AttachedBrowser> {
  const engine = createWeb(
    { viewport: null, ...(options.testIdAttribute === undefined ? {} : { testIdAttribute: options.testIdAttribute }) },
    cdpSource('attach', () => cdpEndpoint),
  );
  // The runner loads only when something attaches, not with every config that imports this package.
  const { openEngine } = await import('e2e/runner');
  const session = await openEngine(engine, { signal: options.signal, timeout: options.timeout });
  return { browser: session.fixtures.browser, screen: session.fixtures.screen, close: session.close, [Symbol.asyncDispose]: session.close };
}
