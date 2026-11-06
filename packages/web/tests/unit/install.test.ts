import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserCheck, browserExecutable, ensureBrowsersInstalled } from '../../src/install.ts';
import type { BrowserName } from '../../src/browser-names.ts';

describe('browserCheck', () => {
  const firstRun = [
    { id: 'browser', status: 'warn', message: 'firefox is not installed; the first run downloads it, or run "npx @e2e-dev/web install firefox" now' },
  ];

  it('passes an installed browser, warns of a first-run download, and reports nothing it cannot tell', async () => {
    expect(await browserCheck('chromium', {}, false, () => true)).toEqual([{ id: 'browser', status: 'pass', message: 'chromium is installed' }]);
    expect(await browserCheck('firefox', {}, false, () => false)).toEqual(firstRun);
    expect(await browserCheck('chromium', {}, false, () => undefined)).toEqual([]);
  });

  it('reads the verdict of a detection that answers later, not the promise', async () => {
    expect(await browserCheck('chromium', {}, false, async () => true)).toEqual([{ id: 'browser', status: 'pass', message: 'chromium is installed' }]);
    expect(await browserCheck('firefox', {}, false, async () => false)).toEqual(firstRun);
    expect(await browserCheck('chromium', {}, false, async () => undefined)).toEqual([]);
  });
});

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
      'Downloading missing browsers (first run): chromium...',
      '|■■■■    |  50% of 171 MiB',
      'Browser download complete.',
    ]);
  });

  it('installs against the run environment, not the process environment', async () => {
    const env = { ...process.env, E2E_BROWSERS_PATH: '/run-specific/browsers' };
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
    expect(contexts[0]?.env['E2E_BROWSERS_PATH']).toBe('/run-specific/browsers');
  });

  it('passes the run mode to the installer', async () => {
    const contexts: { headed: boolean }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      headed: true,
      install: async (_names, context) => {
        contexts.push({ headed: context.headed });
      },
    });
    expect(contexts[0]?.headed).toBe(true);
  });

  // The detection reads the run's own cache, so each case lays out a cache
  // of its own and points the run's environment at it.
  describe('the built-in detection', () => {
    let cache = '';

    /** True when nothing would install for a run in this mode against the laid-out cache. */
    const verdict = async (headed: boolean): Promise<boolean> => {
      let value = true;
      const logs: string[] = [];
      await ensureBrowsersInstalled(['chromium'], {
        headed,
        env: { ...process.env, E2E_BROWSERS_PATH: cache },
        log: (line) => logs.push(line),
        install: async () => { value = false; },
      });
      expect(value).toBe(logs.length === 0);
      return value;
    };

    /** Lays out the chromium builds named: the headless shell, the full browser, or both. */
    const lay = async (...builds: readonly ('shell' | 'full')[]): Promise<void> => {
      for (const build of builds) {
        const executable = await browserExecutable('chromium', build === 'full', { E2E_BROWSERS_PATH: cache });
        mkdirSync(path.dirname(executable), { recursive: true });
        writeFileSync(executable, '');
      }
    };

    beforeEach(() => {
      cache = mkdtempSync(path.join(tmpdir(), 'e2e-browsers-'));
    });

    afterEach(() => {
      rmSync(cache, { recursive: true, force: true });
    });

    it('reads a shell-only cache as installed for a headless run', async () => {
      await lay('shell');
      expect(await verdict(false)).toBe(true);
    });

    it('reads a shell-only cache as missing for a headed run', async () => {
      // A headed run launches the full build, and the shell is not that build.
      await lay('shell');
      expect(await verdict(true)).toBe(false);
    });

    it('reads a full-build-only cache as installed for a headed run', async () => {
      await lay('full');
      expect(await verdict(true)).toBe(true);
    });

    it('reads a full-build-only cache as missing for a headless run', async () => {
      await lay('full');
      expect(await verdict(false)).toBe(false);
    });

    it('reads an empty cache as missing either way', async () => {
      expect(await verdict(false)).toBe(false);
      expect(await verdict(true)).toBe(false);
    });
  });
});
