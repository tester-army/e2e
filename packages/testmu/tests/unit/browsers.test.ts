/**
 * `testmuBrowsers()` builds the CDP URL a TestMu AI session starts on: the
 * capabilities it encodes, credentials read from the run's environment
 * only, session and build names, option validation, log lines that never
 * carry the access key, and a release that calls nothing.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmuBrowsers, type TestmuBrowsersOptions } from '../../src/web.ts';

const ACCESS_KEY = 'LT_secret-access-key';

interface Capabilities {
  browserName: string;
  browserVersion?: string;
  'LT:Options': Record<string, unknown>;
}

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'run-1',
    targetName: 'chromium',
    slot: 0,
    slots: 2,
    env: { LT_USERNAME: 'alice', LT_ACCESS_KEY: ACCESS_KEY },
    signal: new AbortController().signal,
    log: (line: string) => lines.push(line),
    lines,
    ...overrides,
  };
}

function decode(cdpEndpoint: string): { url: URL; capabilities: Capabilities } {
  const url = new URL(cdpEndpoint);
  return { url, capabilities: JSON.parse(url.searchParams.get('capabilities') ?? '{}') as Capabilities };
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('testmuBrowsers() must not call the network');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('testmuBrowsers()', () => {
  it('builds a /puppeteer CDP URL on cdp.lambdatest.com that carries only what the provider needs', async () => {
    const lease = await testmuBrowsers().acquire(request());
    const { url, capabilities } = decode(lease.cdpEndpoint);

    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('wss://cdp.lambdatest.com/puppeteer');
    expect([...url.searchParams.keys()]).toEqual(['capabilities']);
    expect(capabilities).toEqual({
      browserName: 'Chrome',
      'LT:Options': {
        platform: 'Windows 11',
        project: 'e2e',
        build: 'run-1',
        idleTimeout: 600,
        name: 'e2e-run-1-chromium-1',
        user: 'alice',
        accessKey: ACCESS_KEY,
      },
    });
  });

  it('gives each worker slot a lease id without spaces', async () => {
    const provider = testmuBrowsers();
    const leases = await Promise.all([0, 1].map((slot) => provider.acquire(request({ slot }))));

    expect(leases.map((lease) => lease.id)).toEqual(['chromium:slot-1', 'chromium:slot-2']);
  });

  it('is worker scope only', () => {
    expect('scope' in testmuBrowsers()).toBe(false);
  });

  it('names every session e2e-<run id>-<target>-<slot>, as testmu() does', async () => {
    const nameOf = async (overrides: Partial<BrowserRequest>) =>
      decode((await testmuBrowsers().acquire(request(overrides))).cdpEndpoint).capabilities['LT:Options']['name'];

    expect(await nameOf({ runId: '01a0fcab-e8da', targetName: 'checkout-web', slot: 0, slots: 1 })).toBe('e2e-01a0fcab-e8da-checkout-web-1');
    expect(await nameOf({ runId: '01a0fcab-e8da', targetName: 'checkout-web', slot: 2, slots: 3 })).toBe('e2e-01a0fcab-e8da-checkout-web-3');
  });

  it('sends Edge, browserVersion next to browserName, and the rest as LT:Options, which override the build and project defaults', async () => {
    const lease = await testmuBrowsers({
      browserName: 'MicrosoftEdge',
      capabilities: { browserVersion: '140', platform: 'macOS Sequoia', build: 'nightly', project: 'checkout', video: true, idleTimeout: 300 },
    }).acquire(request());
    const { capabilities } = decode(lease.cdpEndpoint);

    expect(capabilities.browserName).toBe('MicrosoftEdge');
    expect(capabilities.browserVersion).toBe('140');
    expect(capabilities['LT:Options']).toEqual({
      platform: 'macOS Sequoia',
      build: 'nightly',
      project: 'checkout',
      video: true,
      idleTimeout: 300,
      browserOptions: ['--user-data-dir=remote-debug-profile-edge'],
      name: 'e2e-run-1-chromium-1',
      user: 'alice',
      accessKey: ACCESS_KEY,
    });
  });

  it('adds --user-data-dir=remote-debug-profile-edge to an Edge session\'s browserOptions', async () => {
    const lease = await testmuBrowsers({ browserName: 'MicrosoftEdge' }).acquire(request());

    expect(decode(lease.cdpEndpoint).capabilities['LT:Options']['browserOptions']).toEqual(['--user-data-dir=remote-debug-profile-edge']);
  });

  it('appends the Edge user-data-dir flag to the browserOptions capabilities give', async () => {
    const lease = await testmuBrowsers({ browserName: 'MicrosoftEdge', capabilities: { browserOptions: ['--no-sandbox'] } }).acquire(request());

    expect(decode(lease.cdpEndpoint).capabilities['LT:Options']['browserOptions']).toEqual(['--no-sandbox', '--user-data-dir=remote-debug-profile-edge']);
  });

  it('keeps a --user-data-dir that capabilities set for Edge', async () => {
    const lease = await testmuBrowsers({ browserName: 'MicrosoftEdge', capabilities: { browserOptions: ['--user-data-dir=mine'] } }).acquire(request());

    expect(decode(lease.cdpEndpoint).capabilities['LT:Options']['browserOptions']).toEqual(['--user-data-dir=mine']);
  });

  it('passes Chrome browserOptions through and adds none', async () => {
    const plain = decode((await testmuBrowsers().acquire(request())).cdpEndpoint).capabilities['LT:Options'];
    const given = decode((await testmuBrowsers({ capabilities: { browserOptions: ['--no-sandbox'] } }).acquire(request())).cdpEndpoint).capabilities['LT:Options'];

    expect('browserOptions' in plain).toBe(false);
    expect(given['browserOptions']).toEqual(['--no-sandbox']);
  });

  it('keeps the platform, build, project, and idleTimeout defaults when capabilities set them to undefined', async () => {
    const lease = await testmuBrowsers({ capabilities: { platform: undefined, build: undefined, project: undefined, idleTimeout: undefined, browserVersion: undefined } }).acquire(request());
    const { capabilities } = decode(lease.cdpEndpoint);

    expect('browserVersion' in capabilities).toBe(false);
    expect(capabilities['LT:Options']).toMatchObject({ platform: 'Windows 11', build: 'run-1', project: 'e2e', idleTimeout: 600 });
  });

  it('takes the credentials from the run environment, not process.env', async () => {
    vi.stubEnv('LT_USERNAME', 'from-process-env');
    vi.stubEnv('LT_ACCESS_KEY', 'from-process-env');
    const options = decode((await testmuBrowsers().acquire(request())).cdpEndpoint).capabilities['LT:Options'];

    expect(options['user']).toBe('alice');
    expect(options['accessKey']).toBe(ACCESS_KEY);
  });

  it('fails the lease when a credential is missing or blank', async () => {
    await expect(testmuBrowsers().acquire(request({ env: { LT_USERNAME: 'alice' } }))).rejects.toThrow('LT_ACCESS_KEY is not set');
    await expect(testmuBrowsers().acquire(request({ env: { LT_USERNAME: ' ', LT_ACCESS_KEY: ACCESS_KEY } }))).rejects.toThrow('LT_USERNAME is not set');
  });

  it.each([
    [{ browsrName: 'Chrome' }, 'testmuBrowsers() has unknown key "browsrName"; did you mean "browserName"?'],
    [{ scope: 'attempt' }, 'testmuBrowsers() has unknown key "scope"'],
    [{ browserVersion: '140' }, 'testmuBrowsers() has unknown key "browserVersion"'],
    [{ browserName: 'Firefox' }, '`browserName` must be one of Chrome, MicrosoftEdge'],
    [{ browserName: null }, '`browserName` must be one of'],
    [{ capabilities: { user: 'mallory', accessKey: 'spoofed' } }, '`capabilities` cannot set `user`, `accessKey`'],
    [{ capabilities: { name: 'smoke' } }, '`capabilities` cannot set `name`'],
    [{ capabilities: null }, '`capabilities` must be an object'],
    [{ capabilities: ['video'] }, '`capabilities` must be an object'],
    [{ capabilities: 'video' }, '`capabilities` must be an object'],
    [{ capabilities: new Map([['video', true]]) }, '`capabilities` must be an object'],
    [{ capabilities: { 'LT:Options': { video: true } } }, 'pass `LT:Options` fields directly in `capabilities`'],
    [{ capabilities: { browserName: 'Firefox' } }, 'set `browserName` as an option'],
    [{ capabilities: { browserOptions: '--no-sandbox' } }, '`capabilities.browserOptions` must be an array of strings'],
    [{ capabilities: { browserOptions: [1] } }, '`capabilities.browserOptions` must be an array of strings'],
    [{ capabilities: { geoLocation: new Date(0) } }, '`capabilities.geoLocation` must be JSON-safe'],
    [{ capabilities: { tunnelName: new Map() } }, '`capabilities.tunnelName` must be JSON-safe'],
    [{ capabilities: { network: { rules: new Map() } } }, '`capabilities.network` must be JSON-safe'],
    [{ capabilities: { tunnel: () => true } }, '`capabilities.tunnel` must be JSON-safe, found function'],
    [{ capabilities: { idleTimeout: Number.NaN } }, '`capabilities.idleTimeout` contains a non-finite number'],
  ])('rejects %j when the provider is created', (options, message) => {
    expect(() => testmuBrowsers(options as unknown as TestmuBrowsersOptions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(message) }),
    );
  });

  it('refuses capabilities JSON cannot encode when the provider is created: a BigInt, a cycle', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => testmuBrowsers({ capabilities: { video: 1n } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('`capabilities.video` must be JSON-safe, found bigint') }),
    );
    expect(() => testmuBrowsers({ capabilities: { network: circular } })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('`capabilities.network` contains a cycle') }),
    );
  });

  it('logs the session and build names but never the access key or the URL', async () => {
    const req = request();
    await testmuBrowsers({ capabilities: { build: 'nightly' } }).acquire(req);

    expect(req.lines).toEqual(['TestMu AI session "e2e-run-1-chromium-1" in build "nightly"']);
    expect(req.lines.join('\n')).not.toContain(ACCESS_KEY);
    expect(req.lines.join('\n')).not.toContain('wss://');
  });

  it('releases without calling anything', async () => {
    const provider = testmuBrowsers();
    const lease = await provider.acquire(request());
    const context: BrowserReleaseContext = {
      runId: 'run-1',
      targetName: 'chromium',
      env: {},
      signal: new AbortController().signal,
      log: () => {},
    };

    await expect(provider.release(lease, context)).resolves.toBeUndefined();
  });
});
