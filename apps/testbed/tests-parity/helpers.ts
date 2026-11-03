/** What the parity tests share: the server's two origins, inline pages, assets, and which browser runs. */

import path from 'node:path';
import { test as base, type WebApp } from '@e2e-dev/web';

type BrowserName = 'chromium' | 'firefox';

/** The app's origin, Playwright's `server.PREFIX`. */
export const PREFIX = 'http://127.0.0.1:4311';

/** Another origin on the same server, Playwright's `server.CROSS_PROCESS_PREFIX`. */
export const CROSS = 'http://localhost:4311';

/** The browser under test: the path its target's app URL ends in (e2e.parity.config.ts). */
export function browserNameOf(app: WebApp): BrowserName {
  const name = new URL(app.baseUrl ?? PREFIX).pathname.replaceAll('/', '');
  if (name !== 'chromium' && name !== 'firefox') throw new Error(`parity app URL names no browser: ${app.baseUrl}`);
  return name;
}

/** The web `test` with `browserName`, Playwright's fixture of the same name. */
export const test = base.extend<{ browserName: BrowserName }>({
  browserName: async ({ app }, use) => use(browserNameOf(app)),
});

/** A path that serves `html` as a page, for Playwright's `page.setContent(html)`. */
export function content(html: string): string {
  return `/content?html=${Buffer.from(html).toString('base64url')}`;
}

/** The absolute path of one of Playwright's test assets. */
export function asset(name: string): string {
  return path.join(import.meta.dirname, '../parity/assets', name);
}
