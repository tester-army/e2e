import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserPlatform, downloadUrl } from '../../src/install/builds.ts';
import { startArchiveServer, type ArchiveServer } from '../helpers/archive-server.ts';
import { browserCheck, browserExecutable, CHROMIUM_BUILD, ensureBrowsersInstalled, FIREFOX_BUILD, installBrowsers } from '../../src/install/provision.ts';

const platform = browserPlatform();

let cache = '';
let server: ArchiveServer;
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  cache = mkdtempSync(path.join(tmpdir(), 'e2e-browsers-'));
  server = await startArchiveServer();
  env = { E2E_BROWSERS_PATH: cache, E2E_BROWSERS_DOWNLOAD_HOST: server.origin };
});

afterEach(async () => {
  await server.close();
  rmSync(cache, { recursive: true, force: true });
});

/** Lays out the chromium builds named in the cache: the headless shell, the full browser, or both. */
async function lay(...builds: readonly ('shell' | 'full')[]): Promise<void> {
  for (const build of builds) {
    const executable = await browserExecutable('chromium', build === 'full', env);
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, '');
  }
}

/** The mirror path the pinned archive of `build` is requested at. */
function served(build: 'chrome' | 'chrome-headless-shell' | 'firefox'): string {
  const buildId = build === 'firefox' ? FIREFOX_BUILD : CHROMIUM_BUILD;
  return decodeURIComponent(downloadUrl(build, buildId, platform!, server.origin).slice(server.origin.length));
}

describe.skipIf(platform === undefined)('browserCheck', () => {
  it('passes an installed browser and warns of a first-run download', async () => {
    await lay('shell');
    expect(await browserCheck('chromium', env, false)).toEqual([{ id: 'browser', status: 'pass', message: 'chromium is installed' }]);
    expect(await browserCheck('firefox', env, false)).toEqual([
      { id: 'browser', status: 'warn', message: 'firefox is not installed; the first run downloads it, or run "npx @e2e-dev/web install firefox" now' },
    ]);
  });
});

describe.skipIf(platform === undefined)('ensureBrowsersInstalled', () => {
  it('downloads nothing when every browser is installed', async () => {
    await lay('shell');
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium', 'chromium'], { env, log: (line) => logs.push(line) });
    expect(logs).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('downloads only the missing browsers, deduplicated, and nothing else', async () => {
    await lay('shell');
    const logs: string[] = [];
    await expect(ensureBrowsersInstalled(['chromium', 'firefox', 'firefox'], { env, log: (line) => logs.push(line) })).rejects.toMatchObject({ code: 'BROWSER_INSTALL_FAILED' });
    expect(server.requests).toEqual([served('firefox')]);
    expect(logs[0]).toBe('Downloading missing browsers (first run): firefox...');
  });

  it('reads the build the run mode launches: a headed run needs full Chrome', async () => {
    await lay('shell');
    await expect(ensureBrowsersInstalled(['chromium'], { env, headed: true, log: () => {} })).rejects.toMatchObject({ code: 'BROWSER_INSTALL_FAILED' });
    expect(server.requests).toEqual([served('chrome')]);
  });

  it("installs into the run environment's cache, not the process's", async () => {
    await expect(ensureBrowsersInstalled(['chromium'], { env, log: () => {} })).rejects.toThrow();
    expect(server.requests).toEqual([served('chrome-headless-shell')]);
    expect(readdirSync(cache)).toEqual(['chrome-headless-shell']);
  });
});

describe.skipIf(platform === undefined)('installBrowsers', () => {
  it('refuses a mirror archive that is not the pinned build, naming both digests', async () => {
    server.route(served('chrome-headless-shell'), Buffer.from('not chrome'));
    const failure = installBrowsers(['chromium'], { env, headed: false, log: () => {} });
    await expect(failure).rejects.toMatchObject({ code: 'BROWSER_INSTALL_FAILED', message: expect.stringMatching(/has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}; refusing it/) });
    expect(existsSync(await browserExecutable('chromium', false, env))).toBe(false);
    expect(readdirSync(path.join(cache, 'chrome-headless-shell'))).toEqual([]);
  });

  it('names the manual install command when a download fails', async () => {
    await expect(installBrowsers(['firefox'], { env, headed: false, log: () => {} })).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_FAILED',
      message: expect.stringMatching(/^could not install firefox stable_159\.0\.1: download of .* failed: 404 Not Found; run "npx @e2e-dev\/web install firefox"/),
    });
  });

  it('refuses a plain http mirror that is not on loopback before downloading', async () => {
    await expect(installBrowsers(['chromium'], { env: { ...env, E2E_BROWSERS_DOWNLOAD_HOST: 'http://mirror.example.com' }, headed: false, log: () => {} }))
      .rejects.toMatchObject({ code: 'BROWSER_INSTALL_FAILED', message: expect.stringContaining('must be an https URL') });
  });

  it('fails with CANCELLED when aborted mid-download, leaving no partial files or lock', async () => {
    const controller = new AbortController();
    server.route(served('chrome-headless-shell'), (_request, response) => {
      response.writeHead(200, { 'content-length': '1000000' });
      response.write(Buffer.alloc(1000), () => controller.abort());
    });
    await expect(installBrowsers(['chromium'], { env, headed: false, log: () => {}, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(readdirSync(cache, { recursive: true })).toEqual(['chrome-headless-shell']);
  });
});
