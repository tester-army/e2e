import { describe, expect, it } from 'vitest';
import { ensureBrowsersInstalled } from '../../src/install.ts';
import type { BrowserName } from '../../src/browser-pool.ts';

describe('ensureBrowsersInstalled', () => {
  it('does nothing when every browser is installed', async () => {
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium', 'firefox'], {
      log: (line) => logs.push(line),
      isInstalled: () => true,
      install: async (names) => {
        installed.push([...names]);
      },
    });
    expect(installed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('installs missing browsers once, deduplicated', async () => {
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium', 'firefox', 'chromium'], {
      log: (line) => logs.push(line),
      isInstalled: (name) => name === 'firefox',
      install: async (names) => {
        installed.push([...names]);
      },
    });
    expect(installed).toEqual([['chromium']]);
    expect(logs[0]).toContain('chromium');
    expect(logs[0]).not.toContain('firefox');
  });

  it('hands the progress log and the signal to the installer', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    await ensureBrowsersInstalled(['chromium'], {
      log: (line) => logs.push(line),
      isInstalled: () => false,
      signal: controller.signal,
      install: async (_names, context) => {
        expect(context.signal).toBe(controller.signal);
        context.log('|■■■■    |  50% of 171 MiB');
      },
    });
    expect(logs).toEqual([
      'Downloading missing Playwright browsers (first run): chromium...',
      '|■■■■    |  50% of 171 MiB',
      'Browser download complete.',
    ]);
  });

  it('installs against the run environment, not the process environment', async () => {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/run-specific/browsers' };
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      env,
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/run-specific/browsers');
  });

  it('defers to the installer when the run points at another browser cache', async () => {
    // The default detection cannot see a cache this process was not started
    // with, so it declines a verdict: the CLI runs with the run's environment
    // and is a no-op when the cache is already complete, and the headline is
    // not printed because nothing is known to be missing.
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/elsewhere/browsers' };
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: (line) => logs.push(line),
      env,
      install: async (names, context) => {
        installed.push([...names]);
        expect(context.env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/elsewhere/browsers');
      },
    });
    expect(installed).toEqual([['chromium']]);
    expect(logs).toEqual([]);
  });

  it('propagates installer failures', async () => {
    await expect(
      ensureBrowsersInstalled(['webkit'], {
        log: () => {},
        isInstalled: () => false,
        install: async () => {
          throw new Error('download failed');
        },
      }),
    ).rejects.toThrow('download failed');
  });
});
