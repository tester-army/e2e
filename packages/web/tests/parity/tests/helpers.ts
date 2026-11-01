/** What the parity tests share: the server's two origins, inline pages, and which browser runs. */

import { test } from '@e2e-dev/web';

const port = Number(process.env['PARITY_PORT'] ?? 4311);

/** The app's origin, Playwright's `server.PREFIX`. */
export const PREFIX = `http://127.0.0.1:${port}`;

/** Another origin on the same server, Playwright's `server.CROSS_PROCESS_PREFIX`. */
export const CROSS = `http://localhost:${port}`;

/** The browser under test. */
export const browserName = (process.env['BROWSER'] ?? 'chromium') as 'chromium' | 'firefox';

/** A path that serves `html` as a page, for Playwright's `page.setContent(html)`. */
export function content(html: string): string {
  return `/content?html=${Buffer.from(html).toString('base64url')}`;
}

/**
 * Skips the running test where e2e itself differs from Playwright, in every
 * browser unless `on.browser` narrows it: `reason` names the difference.
 */
export function e2eGap(reason: string, on: { readonly browser?: 'chromium' | 'firefox' } = {}): void {
  test.skip(on.browser === undefined || on.browser === browserName, `e2e: ${reason}`);
}
