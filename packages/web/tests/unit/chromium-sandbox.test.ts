/**
 * Chromium launches with its OS sandbox on by default, and the opt-out
 * turns it off. The agent can follow the app to another origin, so a
 * renderer exploit on a page it reaches must stay contained by the sandbox
 * instead of running as the user running `e2e run`.
 */
import type { Browser } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserConnection } from '../../src/browser-connection.ts';
import { web } from '../../src/engine.ts';

const chromiumLaunch = vi.hoisted(() => vi.fn());
const firefoxLaunch = vi.hoisted(() => vi.fn());
const webkitLaunch = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({
  chromium: { launch: chromiumLaunch },
  firefox: { launch: firefoxLaunch },
  webkit: { launch: webkitLaunch },
  selectors: { register: vi.fn() },
}));

/** A browser that reports itself connected, with the `close` its owner is expected to call. */
function fakeBrowser(connected: () => boolean = () => true) {
  const close = vi.fn(async () => undefined);
  return { browser: { isConnected: connected, close } as unknown as Browser, close };
}

/** The single launch options object a mocked browser type was called with. */
function launchOf(type: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = (type as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]![0] as Record<string, unknown>;
}

describe('BrowserConnection', () => {
  beforeEach(() => {
    chromiumLaunch.mockReset();
    firefoxLaunch.mockReset();
    webkitLaunch.mockReset();
  });

  it('launches chromium with the sandbox on when asked', async () => {
    const { browser } = fakeBrowser();
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true });
    expect(launchOf(chromiumLaunch)).toEqual({
      headless: true,
      timeout: 1_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      chromiumSandbox: true,
    });
    await connection.dispose();
  });

  it('keeps the sandbox on for a headed run', async () => {
    const { browser } = fakeBrowser();
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: true, timeoutMs: 1_000, chromiumSandbox: true });
    expect(launchOf(chromiumLaunch)).toMatchObject({ headless: false, chromiumSandbox: true });
    await connection.dispose();
  });

  it('launches chromium with the sandbox off when asked', async () => {
    const { browser } = fakeBrowser();
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false });
    expect(launchOf(chromiumLaunch)).toMatchObject({ chromiumSandbox: false });
    await connection.dispose();
  });

  it('keeps the opt-out on a relaunch after a disconnect', async () => {
    let connected = true;
    const { browser } = fakeBrowser(() => connected);
    chromiumLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false });
    connected = false;
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false });
    expect(chromiumLaunch).toHaveBeenCalledTimes(2);
    for (const call of chromiumLaunch.mock.calls) {
      expect(call[0]).toMatchObject({ chromiumSandbox: false });
    }
    await connection.dispose();
  });

  it('keeps the sandbox on when a relaunch fails while another caller is waiting', async () => {
    let connected = true;
    const { browser: first } = fakeBrowser(() => connected);
    const { browser: third } = fakeBrowser();
    chromiumLaunch
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('browserType.launch: Chromium sandboxing failed!'))
      .mockResolvedValueOnce(third);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true });
    connected = false;
    const [relaunch, waiter] = await Promise.allSettled([
      connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true }),
      connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true }),
    ]);
    expect(relaunch.status).toBe('rejected');
    expect(waiter.status).toBe('fulfilled');
    expect(chromiumLaunch).toHaveBeenCalledTimes(3);
    for (const call of chromiumLaunch.mock.calls) {
      expect(call[0]).toMatchObject({ chromiumSandbox: true });
    }
    await connection.dispose();
  });

  it('turns a sandbox launch failure into a friendly error naming both opt-outs', async () => {
    chromiumLaunch.mockRejectedValueOnce(
      new Error(
        'browserType.launch: Target page, context or browser has been closed\n' +
          'Chromium sandboxing failed!\n' +
          'Call log:\n' +
          '  - launching Chromium with --no-sandbox --flag-a --flag-b',
      ),
    );
    const connection = new BrowserConnection();
    let error: (Error & { code?: unknown; cause?: unknown }) | undefined;
    try {
      await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true });
    } catch (caught) {
      error = caught as Error & { code?: unknown; cause?: unknown };
    }
    expect(error?.code).toBe('ENGINE_FAILURE');
    expect(error?.message).toContain('E2E_CHROMIUM_SANDBOX=0');
    expect(error?.message).toContain('web({ chromiumSandbox: false })');
    expect(error?.message).not.toContain('Call log');
    expect(error?.message).not.toContain('--flag-a');
    expect(error?.cause).toBeUndefined();
    await connection.dispose();
  });

  it('names only the option in the launch error when the option set the sandbox', async () => {
    chromiumLaunch.mockRejectedValueOnce(new Error('browserType.launch: Chromium sandboxing failed!'));
    const connection = new BrowserConnection();
    let error: (Error & { code?: unknown }) | undefined;
    try {
      await connection.acquire({
        name: 'chromium',
        headed: false,
        timeoutMs: 1_000,
        chromiumSandbox: true,
        chromiumSandboxConfigured: true,
      });
    } catch (caught) {
      error = caught as Error & { code?: unknown };
    }
    expect(error?.code).toBe('ENGINE_FAILURE');
    expect(error?.message).toContain('web({ chromiumSandbox: false })');
    expect(error?.message).not.toContain('E2E_CHROMIUM_SANDBOX');
    await connection.dispose();
  });

  it('passes any other launch failure through unchanged', async () => {
    const failure = new Error('browserType.launch: executable does not exist');
    chromiumLaunch.mockRejectedValueOnce(failure);
    const connection = new BrowserConnection();
    await expect(
      connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: true }),
    ).rejects.toBe(failure);
    await connection.dispose();
  });

  it('keeps the opt-out when a relaunch fails while another caller is waiting', async () => {
    let connected = true;
    const { browser: first } = fakeBrowser(() => connected);
    const { browser: third } = fakeBrowser();
    chromiumLaunch
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('browserType.launch: Chromium sandboxing failed!'))
      .mockResolvedValueOnce(third);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false });
    connected = false;
    const [relaunch, waiter] = await Promise.allSettled([
      connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false }),
      connection.acquire({ name: 'chromium', headed: false, timeoutMs: 1_000, chromiumSandbox: false }),
    ]);
    expect(relaunch.status).toBe('rejected');
    expect(waiter.status).toBe('fulfilled');
    expect(chromiumLaunch).toHaveBeenCalledTimes(3);
    for (const call of chromiumLaunch.mock.calls) {
      expect(call[0]).toMatchObject({ chromiumSandbox: false });
    }
    await connection.dispose();
  });

  it('does not pass the chromium-only option to firefox or webkit', async () => {
    const { browser } = fakeBrowser();
    firefoxLaunch.mockResolvedValue(browser);
    webkitLaunch.mockResolvedValue(browser);
    const connection = new BrowserConnection();
    await connection.acquire({ name: 'firefox', headed: false, timeoutMs: 1_000, chromiumSandbox: true });
    await connection.dispose();
    expect(launchOf(firefoxLaunch)).not.toHaveProperty('chromiumSandbox');
    const second = new BrowserConnection();
    await second.acquire({ name: 'webkit', headed: false, timeoutMs: 1_000, chromiumSandbox: true });
    await second.dispose();
    expect(launchOf(webkitLaunch)).not.toHaveProperty('chromiumSandbox');
  });
});

describe('web({ chromiumSandbox })', () => {
  it('rejects a value that is not a boolean as INVALID_CONFIG', () => {
    expect(() => web({ chromiumSandbox: 'yes' as unknown as boolean })).toThrowError(/must be a boolean/);
  });

  it('accepts true and false', () => {
    expect(() => web({ chromiumSandbox: true })).not.toThrow();
    expect(() => web({ chromiumSandbox: false })).not.toThrow();
  });
});
