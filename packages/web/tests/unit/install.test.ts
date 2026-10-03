import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureBrowsersInstalled, installArgs } from '../../src/install.ts';
import { browserType, type BrowserName } from '../../src/browser-connection.ts';

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

  it('does not collect the browsers the declared cache holds', async () => {
    // The run spawns the install with the cache it was pointed at, and that
    // command removes every revision no installed Playwright declares. Those
    // revisions belong to the other tools sharing that cache.
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts[0]?.env['PLAYWRIGHT_SKIP_BROWSER_GC']).toBe('1');
  });

  it('keeps a browser collection the caller asked for', async () => {
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '0' },
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts[0]?.env['PLAYWRIGHT_SKIP_BROWSER_GC']).toBe('0');
  });

  it('asks for the shell only on a headless chromium run', () => {
    // The assertion the install runs on: a headless chromium run launches the
    // shell, so `--only-shell` keeps the full build out of its download. A headed
    // run launches the full build, and so does a browser that has no shell.
    expect(installArgs(['chromium'], false)).toEqual(['--only-shell', 'chromium']);
    expect(installArgs(['chromium'], true)).toEqual(['chromium']);
    expect(installArgs(['firefox'], false)).toEqual(['firefox']);
    expect(installArgs(['chromium', 'firefox'], false)).toEqual(['--only-shell', 'chromium', 'firefox']);
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

  // The bug lived in the built-in detection, so it is exercised against a real
  // browser cache rather than an injected verdict. Playwright resolves its cache
  // when it is first loaded and this file has already loaded it, so the real
  // function runs in a child process started with the environment set up here.
  describe('the built-in detection', () => {
    // The revision the installed Playwright declares: the reported executable
    // names it, and a cache under another revision is not the one a run reads.
    const reported = browserType('chromium').executablePath();
    const revision = reported.slice(reported.lastIndexOf('chromium-') + 'chromium-'.length).split(path.sep)[0] ?? '';
    // The child runs the built package, the same one a user gets, so the check it
    // exercises is the one that ships.
    const built = createRequire(import.meta.url).resolve('../../dist/install.js');
    const packageDir = path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
    let cache = '';
    let previous: string | undefined;

    /** Calls the exported check in a process that loaded Playwright with this cache. */
    const verdict = (headed: boolean): boolean => {
      const probe = path.join(cache, 'probe.mjs');
      writeFileSync(
        probe,
        `import { isBrowserInstalled } from ${JSON.stringify(built)};
const value = isBrowserInstalled('chromium', process.env, ${String(headed)});
console.log(String(value));
`,
      );
      const child = spawnSync(process.execPath, [probe], {
        encoding: 'utf8',
        cwd: path.dirname(path.dirname(packageDir)),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache },
      });
      if (child.status !== 0) throw new Error(`the detection probe failed: ${child.stderr}`);
      expect(child.stdout.trim()).not.toBe('undefined');
      return child.stdout.trim() === 'true';
    };

    /** Lays out the builds named, each with its completion marker. */
    const lay = (...builds: readonly ('shell' | 'full')[]): void => {
      for (const build of builds) {
        const dir = build === 'shell' ? `chromium_headless_shell-${revision}` : `chromium-${revision}`;
        const bin = build === 'shell' ? 'chrome-headless-shell-linux64' : 'chrome-linux64';
        const exe = build === 'shell' ? 'chrome-headless-shell' : 'chrome';
        mkdirSync(path.join(cache, dir, bin), { recursive: true });
        writeFileSync(path.join(cache, dir, bin, exe), '');
        writeFileSync(path.join(cache, dir, 'INSTALLATION_COMPLETE'), '');
      }
    };

    beforeEach(() => {
      cache = mkdtempSync(path.join(tmpdir(), 'e2e-browsers-'));
      previous = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    });

    afterEach(() => {
      if (previous === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
      else process.env['PLAYWRIGHT_BROWSERS_PATH'] = previous;
      rmSync(cache, { recursive: true, force: true });
    });

    it('reads a shell-only cache as installed for a headless run', () => {
      // The full build executablePath() names is absent, which is what a run with
      // only the shell installed looks like.
      lay('shell');
      expect(verdict(false)).toBe(true);
    });

    it('reads a shell-only cache as missing for a headed run', () => {
      // A headed run launches the full build, and the shell is not that build.
      lay('shell');
      expect(verdict(true)).toBe(false);
    });

    it('reads a full-build-only cache as installed for a headed run', () => {
      lay('full');
      expect(verdict(true)).toBe(true);
    });

    it('reads a full-build-only cache as missing for a headless run', () => {
      // `playwright install --no-shell` leaves exactly this, and the headless
      // launch would then fail on the shell it never got.
      lay('full');
      expect(verdict(false)).toBe(false);
    });

    it('reads an empty cache as missing either way', () => {
      expect(verdict(false)).toBe(false);
      expect(verdict(true)).toBe(false);
    });
  });
});
