/**
 * `testmuai()` builds the CDP URL a TestMu AI session starts on: the
 * capabilities it encodes, credentials read from the run's environment
 * only, session and build names, the route and hub options, scope, option
 * validation, log lines that never carry the access key, and a release that
 * calls nothing.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmuai, type TestMuAIOptions } from '../../src/index.ts';

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
    throw new Error('testmuai() must not call the network');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('testmuai()', () => {
  it('builds a /puppeteer CDP URL on cdp.lambdatest.com with the run and target in the names', async () => {
    const lease = await testmuai().acquire(request());
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
        build: 'e2e run-1',
        name: 'e2e chromium slot 1 of 2',
        user: 'alice',
        accessKey: ACCESS_KEY,
      },
    });
    expect(lease.id).toBe('chromium:slot 1 of 2');
  });

  it('names a per-attempt session after the attempt', async () => {
    const provider = testmuai({ scope: 'attempt' });
    const lease = await provider.acquire(request({ attemptId: 'attempt-7' }));

    expect(provider.scope).toBe('attempt');
    expect(decode(lease.cdpEndpoint).capabilities['LT:Options']['name']).toBe('e2e chromium attempt-7');
    expect(lease.id).toBe('chromium:attempt-7');
  });

  it('leaves scope to the engine default when none is given', () => {
    expect('scope' in testmuai()).toBe(false);
  });

  it('honours the route, hub, browser, platform, build, and extra capabilities', async () => {
    const lease = await testmuai({
      route: '/playwright-cdp',
      hub: 'cdp.eu.example.test',
      browserName: 'MicrosoftEdge',
      browserVersion: '140',
      platform: 'macOS Sequoia',
      build: 'nightly',
      capabilities: { video: true, idleTimeout: 300 },
    }).acquire(request());
    const { url, capabilities } = decode(lease.cdpEndpoint);

    expect(url.host).toBe('cdp.eu.example.test');
    expect(url.pathname).toBe('/playwright-cdp');
    expect(capabilities.browserName).toBe('MicrosoftEdge');
    expect(capabilities.browserVersion).toBe('140');
    expect(capabilities['LT:Options']).toMatchObject({ platform: 'macOS Sequoia', build: 'nightly', video: true, idleTimeout: 300 });
  });

  it('takes the credentials from the run environment, not process.env', async () => {
    vi.stubEnv('LT_USERNAME', 'from-process-env');
    vi.stubEnv('LT_ACCESS_KEY', 'from-process-env');
    const options = decode((await testmuai().acquire(request())).cdpEndpoint).capabilities['LT:Options'];

    expect(options['user']).toBe('alice');
    expect(options['accessKey']).toBe(ACCESS_KEY);
  });

  it('fails the lease when a credential is missing or blank', async () => {
    await expect(testmuai().acquire(request({ env: { LT_USERNAME: 'alice' } }))).rejects.toThrow(
      'LT_USERNAME and LT_ACCESS_KEY must be set',
    );
    await expect(testmuai().acquire(request({ env: { LT_USERNAME: ' ', LT_ACCESS_KEY: ACCESS_KEY } }))).rejects.toThrow(
      'LT_USERNAME and LT_ACCESS_KEY must be set',
    );
  });

  it.each([
    [{ platfrom: 'macOS Sequoia' }, 'testmuai() has unknown key "platfrom"; did you mean "platform"?'],
    [{ route: 'playwright-cdp' }, '`route` must be one of /puppeteer, /playwright-cdp'],
    [{ hub: 'https://cdp.lambdatest.com' }, '`hub` must be a host'],
    [{ hub: 'cdp.lambdatest.com/puppeteer' }, '`hub` must be a host'],
    [{ browserName: 'Firefox' }, '`browserName` must be one of Chrome, MicrosoftEdge'],
    [{ capabilities: { user: 'mallory', accessKey: 'spoofed' } }, '`capabilities` cannot set `user`, `accessKey`'],
    [{ capabilities: { build: 'nightly', platform: 'Windows 10' } }, '`capabilities` cannot set `build`, `platform`'],
    [null, 'testmuai() options must be an object'],
    [[], 'testmuai() options must be an object'],
    [{ capabilities: null }, '`capabilities` must be an object'],
    [{ capabilities: ['video'] }, '`capabilities` must be an object'],
    [{ capabilities: 'video' }, '`capabilities` must be an object'],
  ])('rejects %j when the provider is created', (options, message) => {
    expect(() => testmuai(options as unknown as TestMuAIOptions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(message) }),
    );
  });

  it('keeps 25 worker-scope leases inside the engine\'s 16 KB hand-off', async () => {
    const provider = testmuai({ capabilities: { video: true, network: true, console: true, tunnel: true, tunnelName: 'ci-tunnel' } });
    const runId = '01a0fcab-e8da-797a-8b35-2168b81385c0';
    const env = { LT_USERNAME: 'some.user.name', LT_ACCESS_KEY: `LT_${'x'.repeat(46)}` };
    const leases = await Promise.all(
      Array.from({ length: 25 }, (_, slot) => provider.acquire(request({ runId, targetName: 'checkout-web', slot, slots: 25, env }))),
    );

    expect(Buffer.byteLength(JSON.stringify({ slots: 25, leases }))).toBeLessThan(16 * 1024);
  });

  it('logs the session and build names but never the access key or the URL', async () => {
    const req = request();
    await testmuai().acquire(req);

    expect(req.lines).toEqual(['TestMu AI session "e2e chromium slot 1 of 2" in build "e2e run-1"']);
    expect(req.lines.join('\n')).not.toContain(ACCESS_KEY);
    expect(req.lines.join('\n')).not.toContain('wss://');
  });

  it('releases without calling anything', async () => {
    const provider = testmuai();
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
