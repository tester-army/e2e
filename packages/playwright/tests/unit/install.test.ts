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
