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
