/** Shares one browser process per engine/headed mode across a worker's attempts. */

import type { Browser } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/**
 * Launching a browser process costs hundreds of milliseconds; per-attempt
 * isolation lives in browser contexts, so every attempt a worker runs can
 * share the process. The pool relaunches a browser that crashed or
 * disconnected and is emptied by `dispose` (wired to the backend `dispose`
 * hook).
 */
export class BrowserPool {
  private readonly browsers = new Map<string, Promise<Browser>>();

  /** Returns a connected shared browser, launching or relaunching as needed. */
  async acquire(name: BrowserName, headed: boolean, timeoutMs: number): Promise<Browser> {
    const key = `${name}:${headed ? 'headed' : 'headless'}`;
    const cached = this.browsers.get(key);
    if (cached !== undefined) {
      const browser = await cached.catch(() => null);
      if (browser !== null && browser.isConnected()) return browser;
      this.browsers.delete(key);
    }
    const launching = browserType(name).launch({ headless: !headed, timeout: timeoutMs });
    this.browsers.set(key, launching);
    try {
      return await launching;
    } catch (cause) {
      this.browsers.delete(key);
      throw cause;
    }
  }

  /** Closes every pooled browser process; idempotent and best-effort. */
  async dispose(): Promise<void> {
    const pending = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(
      pending.map(async (launching) => {
        try {
          await (await launching).close();
        } catch {
          // dispose is best-effort cleanup
        }
      }),
    );
  }
}

/** Maps a browser name to its Playwright BrowserType. */
export function browserType(name: BrowserName): typeof chromium {
  if (name === 'firefox') return firefox;
  if (name === 'webkit') return webkit;
  return chromium;
}
