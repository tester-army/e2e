/**
 * `testmuBrowsers()` builds the CDP URL a TestMu AI session starts on: the
 * capabilities it encodes, credentials read from the run's environment
 * only, session and build names, the route and hub options, scope, option
 * validation, log lines that never carry the access key, and a release that
 * calls nothing.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmuBrowsers, type TestmuBrowsersOptions } from '../../src/web.ts';

const ACCESS_KEY = 'LT_secret-access-key';

interface Capabilities {
  browserName: string;
  browserVersion: string;
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
  it('builds a /puppeteer CDP URL on cdp.lambdatest.com with the run and target in the names', async () => {
    const lease = await testmuBrowsers().acquire(request());
    const { url, capabilities } = decode(lease.cdpEndpoint);

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('cdp.lambdatest.com');
    expect(url.pathname).toBe('/puppeteer');
    expect(capabilities).toEqual({
      browserName: 'Chrome',
      browserVersion: 'latest',
      'LT:Options': {
        idleTimeout: 600,
        platform: 'Windows 11',
        project: 'e2e',
        build: 'run-1',
        name: 'e2e-run-1-chromium-1',
        user: 'alice',
        accessKey: ACCESS_KEY,
      },
    });
    expect(lease.id).toBe('chromium:slot 1 of 2');
  });

  it('names a per-attempt session after the attempt', async () => {
    const provider = testmuBrowsers({ scope: 'attempt' });
    const lease = await provider.acquire(request({ attemptId: 'attempt-7' }));

    expect(provider.scope).toBe('attempt');
    expect(decode(lease.cdpEndpoint).capabilities['LT:Options']['name']).toBe('e2e-run-1-chromium-attempt-7');
    expect(lease.id).toBe('chromium:attempt-7');
  });

  it('leaves scope to the engine default when none is given', () => {
    expect('scope' in testmuBrowsers()).toBe(false);
  });

  it('honours the route, hub, browser, platform, build, and extra capabilities', async () => {
    const lease = await testmuBrowsers({
      route: '/playwright-cdp',
      hub: 'cdp.eu.example.test',
      browserName: 'MicrosoftEdge',
      browserVersion: '140',
      platform: 'macOS Sequoia',
      build: 'nightly',
      project: 'checkout',
      geoLocation: 'FR',
      timezone: 'UTC+01:00',
      capabilities: { video: true, idleTimeout: 300 },
    }).acquire(request());
    const { url, capabilities } = decode(lease.cdpEndpoint);

    expect(url.host).toBe('cdp.eu.example.test');
    expect(url.pathname).toBe('/playwright-cdp');
    expect(capabilities.browserName).toBe('MicrosoftEdge');
    expect(capabilities.browserVersion).toBe('140');
    expect(capabilities['LT:Options']).toMatchObject({
      platform: 'macOS Sequoia',
      project: 'checkout',
      build: 'nightly',
      geoLocation: 'FR',
      timezone: 'UTC+01:00',
      video: true,
      idleTimeout: 300,
    });
  });

  it('names sessions like testmu() does: a given sessionName gets the slot or attempt appended when needed', async () => {
    const nameOf = async (options: TestmuBrowsersOptions, overrides: Partial<BrowserRequest> = {}) =>
      decode((await testmuBrowsers(options).acquire(request(overrides))).cdpEndpoint).capabilities['LT:Options']['name'];

    expect(await nameOf({ sessionName: 'smoke' }, { slots: 1 })).toBe('smoke');
    expect(await nameOf({ sessionName: 'smoke' }, { slot: 1, slots: 2 })).toBe('smoke-2');
    expect(await nameOf({ sessionName: 'smoke', scope: 'attempt' }, { attemptId: 'attempt-3' })).toBe('smoke-attempt-3');
    expect(await nameOf({}, { slot: 1, slots: 2 })).toBe('e2e-run-1-chromium-2');
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
    [{ platfrom: 'macOS Sequoia' }, 'testmuBrowsers() has unknown key "platfrom"; did you mean "platform"?'],
    [{ route: 'playwright-cdp' }, '`route` must be one of /puppeteer, /playwright-cdp'],
    [{ hub: 'https://cdp.lambdatest.com' }, '`hub` must be a host'],
    [{ hub: 'cdp.lambdatest.com/puppeteer' }, '`hub` must be a host'],
    [{ browserName: 'Firefox' }, '`browserName` must be one of Chrome, MicrosoftEdge'],
    [{ capabilities: { user: 'mallory', accessKey: 'spoofed' } }, '`capabilities` cannot set `user`, `accessKey`'],
    [{ capabilities: { build: 'nightly', platform: 'Windows 10' } }, '`capabilities` cannot set `build`, `platform`'],
    [{ capabilities: { browserName: 'Firefox', browserVersion: '120' } }, '`capabilities` cannot set `browserName`, `browserVersion`'],
    [{ capabilities: { 'LT:Options': { video: true } } }, '`capabilities` cannot set `LT:Options`'],
    [{ hub: null }, '`hub` must be a host'],
    [{ route: null }, '`route` must be one of'],
    [{ browserName: null }, '`browserName` must be one of'],
    [{ scope: 'session' }, '`scope` must be one of worker, attempt'],
    [{ scope: null }, '`scope` must be one of worker, attempt'],
    [{ build: '' }, '`build` must be a non-empty string'],
    [{ project: 1 }, '`project` must be a non-empty string'],
    [{ sessionName: null }, '`sessionName` must be a non-empty string'],
    [{ browserVersion: ' ' }, '`browserVersion` must be a non-empty string'],
    [{ capabilities: { project: 'x', geoLocation: 'US' } }, '`capabilities` cannot set `project`, `geoLocation`'],
    [null, 'testmuBrowsers() options must be an object'],
    [[], 'testmuBrowsers() options must be an object'],
    [{ capabilities: null }, '`capabilities` must be an object'],
    [{ capabilities: ['video'] }, '`capabilities` must be an object'],
    [{ capabilities: 'video' }, '`capabilities` must be an object'],
  ])('rejects %j when the provider is created', (options, message) => {
    expect(() => testmuBrowsers(options as unknown as TestmuBrowsersOptions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(message) }),
    );
  });

  it('keeps 24 worker-scope leases inside the engine\'s 16 KB hand-off', async () => {
    const provider = testmuBrowsers({ capabilities: { video: true, network: true, console: true, tunnel: true, tunnelName: 'ci-tunnel' } });
    const runId = '01a0fcab-e8da-797a-8b35-2168b81385c0';
    const env = { LT_USERNAME: 'some.user.name', LT_ACCESS_KEY: `LT_${'x'.repeat(46)}` };
    const leases = await Promise.all(
      Array.from({ length: 24 }, (_, slot) => provider.acquire(request({ runId, targetName: 'checkout-web', slot, slots: 24, env }))),
    );

    expect(Buffer.byteLength(JSON.stringify({ slots: 24, leases }))).toBeLessThan(16 * 1024);
  });

  it('logs the session and build names but never the access key or the URL', async () => {
    const req = request();
    await testmuBrowsers().acquire(req);

    expect(req.lines).toEqual(['TestMu AI session "e2e-run-1-chromium-1" in build "run-1"']);
    expect(req.lines.join('\n')).not.toContain(ACCESS_KEY);
    expect(req.lines.join('\n')).not.toContain('wss://');
  });

  it('is exported from @e2e-dev/testmu/web only: the package root stays device-only', async () => {
    const root: Record<string, unknown> = await import('../../src/index.ts');
    expect(Object.keys(root)).toEqual(['testmu']);
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
