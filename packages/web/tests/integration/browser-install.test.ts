/**
 * A real install of the pinned headless shell from Chrome for Testing into a
 * fresh cache, then a BiDi session on it. Skipped when the download host
 * cannot be reached, so an offline machine runs the rest of the suite.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchBidiBrowser } from '../../src/driver/launch.ts';
import { browserPlatform, downloadUrl } from '../../src/install/builds.ts';
import { browserExecutable, CHROMIUM_BUILD, installBrowsers } from '../../src/install/provision.ts';

const platform = browserPlatform();

/** Whether the headless shell's archive answers within a few seconds. */
async function reachable(): Promise<boolean> {
  if (platform === undefined) return false;
  try {
    const response = await fetch(downloadUrl('chrome-headless-shell', CHROMIUM_BUILD, platform), { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const online = await reachable();

describe.skipIf(!online)('installing the pinned headless shell', () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'e2e-browser-install-'));
  const env = { ...process.env, E2E_BROWSERS_PATH: cache };

  afterAll(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it('downloads it into the cache and opens a BiDi session on it', { timeout: 300_000 }, async () => {
    const logs: string[] = [];
    await installBrowsers(['chromium'], { log: (line) => logs.push(line), env, headed: false });
    const executable = await browserExecutable('chromium', false, env);
    expect(existsSync(executable)).toBe(true);
    expect(logs).toEqual([`Downloading chrome-headless-shell ${CHROMIUM_BUILD} into ${cache}`]);
    expect(readdirSync(path.join(cache, 'chrome-headless-shell'))).toEqual([`${platform!.cacheKey}-${CHROMIUM_BUILD}`]);

    const browser = await launchBidiBrowser('chromium', { headed: false, timeoutMs: 30_000, executablePath: executable, env: process.env, signal: new AbortController().signal });
    try {
      const { context } = await browser.connection.send('browsingContext.create', { type: 'tab' });
      const result = await browser.connection.send('script.evaluate', {
        expression: 'navigator.userAgent',
        target: { context },
        awaitPromise: false,
      });
      expect(result).toMatchObject({ type: 'success', result: { type: 'string', value: expect.stringContaining(`HeadlessChrome/${CHROMIUM_BUILD}`) } });
    } finally {
      await browser.close();
    }
  });
});
