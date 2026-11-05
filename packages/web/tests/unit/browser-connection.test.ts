/** The shared browser connection owns its first launch from the moment it is asked for, while Playwright is still loading. */
import type { Browser } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { BrowserConnection } from '../../src/browser-connection.ts';

/** A browser that reports itself connected, with the `close` its owner is expected to call. */
function fakeBrowser() {
  const close = vi.fn(async () => undefined);
  return { browser: { isConnected: () => true, close } as unknown as Browser, close };
}

it('closes the browser a first launch produces when dispose arrives before that launch settles', async () => {
  const { browser, close } = fakeBrowser();
  const connection = new BrowserConnection();
  const acquiring = connection.acquire('chromium', false, 1_000, async () => browser);
  await connection.dispose();
  await acquiring;
  expect(close).toHaveBeenCalledOnce();
});

it('launches once for two callers that ask before the first launch settles', async () => {
  const { browser } = fakeBrowser();
  const connect = vi.fn(async () => browser);
  const connection = new BrowserConnection();
  const [first, second] = await Promise.all([
    connection.acquire('chromium', false, 1_000, connect),
    connection.acquire('chromium', false, 1_000, connect),
  ]);
  expect(connect).toHaveBeenCalledOnce();
  expect(second).toBe(first);
});
