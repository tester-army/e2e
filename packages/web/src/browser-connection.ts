/** Shares one browser process connection across a worker's attempts. */

import type { Browser } from 'playwright';
import { chromium, firefox, selectors, webkit } from 'playwright';
import { SELECTOR_ENGINES } from './selector-engines.ts';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/**
 * Playwright's default SIGINT handler closes the browser and exits the
 * process, and its SIGTERM handler closes the browser. A terminal Ctrl-C
 * reaches the worker's whole process group, so they would end the test
 * mid-step before the runner's interrupt reports it. The runner owns those
 * interrupts; the browser runs in its own process group, so the signal never
 * reaches it, and the engine's `dispose` closes it. SIGHUP stays Playwright's:
 * the runner does not handle a hangup, and its handler is what closes the
 * browser when the terminal goes away.
 */
const RUNNER_OWNS_SIGNALS = { handleSIGINT: false, handleSIGTERM: false } as const;

/**
 * Launching a browser process costs hundreds of milliseconds; per-attempt
 * isolation lives in browser contexts, so every attempt a worker runs can
 * share the process. The connection relaunches a browser that crashed or
 * disconnected and is emptied by `dispose` (wired to the engine `dispose`
 * hook).
 */
export class BrowserConnection {
  private pending: Promise<Browser> | undefined;

  /**
   * Returns a connected shared browser, launching or relaunching as needed.
   * When `connect` is given the connection attaches to a remote browser through it
   * instead of launching a local one; `connect` is re-invoked on a relaunch,
   * so a caller that resolves a fresh per-run endpoint reconnects cleanly
   * after a dropped session.
   */
  async acquire(
    name: BrowserName,
    headed: boolean,
    timeoutMs: number,
    connect?: () => Promise<Browser>,
  ): Promise<Browser> {
    const cached = this.pending;
    if (cached !== undefined) {
      const browser = await cached.catch(() => null);
      if (browser !== null && browser.isConnected()) return browser;
      if (this.pending !== cached) return this.acquire(name, headed, timeoutMs, connect);
      this.pending = undefined;
    }
    await registerSelectorEngines();
    const launching =
      connect !== undefined ? connect() : browserType(name).launch({ headless: !headed, timeout: timeoutMs, ...RUNNER_OWNS_SIGNALS });
    this.pending = launching;
    try {
      return await launching;
    } catch (cause) {
      if (this.pending === launching) this.pending = undefined;
      throw cause;
    }
  }

  /** Closes the connection, including a launch still in flight; idempotent and best-effort. */
  async dispose(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    try {
      await (await pending)?.close();
    } catch {
      // Disposal still owns a failed or abandoned launch.
    }
  }
}

/** Maps a browser name to its Playwright BrowserType. */
export function browserType(name: BrowserName): typeof chromium {
  if (name === 'firefox') return firefox;
  if (name === 'webkit') return webkit;
  return chromium;
}

/**
 * Attaches to a remote browser over the Chrome DevTools Protocol. CDP attach
 * is chromium-only; a hosted-browser engine (a per-run cloud session) resolves
 * the endpoint itself and hands it here. `browser.close()` on the result
 * detaches the CDP session without killing the remote process the host owns.
 */
export async function connectCdp(endpoint: string, timeoutMs: number): Promise<Browser> {
  await registerSelectorEngines();
  return chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
}

/** Registration is process-wide and rejected twice; one shared promise serves every connection. */
let selectorEngines: Promise<void> | undefined;

/**
 * Registers the engine's selector engines. Playwright requires it before the
 * first page of the process exists, and a name registers once, so every
 * acquire awaits the same registration.
 */
function registerSelectorEngines(): Promise<void> {
  // Playwright serializes a function argument with `toString()` and invokes it
  // in the page, so each factory is materialized from its source here to keep
  // the in-page code self-contained, the same way the reader is assembled.
  selectorEngines ??= Promise.all(
    SELECTOR_ENGINES.map(({ name, source }) =>
      selectors.register(name, new Function(`return ${source};`)() as () => unknown),
    ),
  ).then(() => undefined);
  return selectorEngines;
}
