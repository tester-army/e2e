import { describe, expect, it } from 'vitest';
import { isCiMode, resolveConfig } from '../../src/config/resolve.ts';
import { defineDriver } from '../../src/driver/index.ts';

const ROOT = '/tmp/e2e-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

function resolve(raw: Parameters<typeof resolveConfig>[0], env: NodeJS.ProcessEnv = BASE_ENV) {
  return resolveConfig(raw, { projectRoot: ROOT, env });
}

describe('CI mode', () => {
  it('is active unless CI is empty, 0, or false (case-insensitive)', () => {
    expect(isCiMode({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCiMode({ CI: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isCiMode({ CI: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isCiMode({ CI: 'False' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isCiMode({ CI: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCiMode({ CI: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('resolveConfig', () => {
  it('applies specification defaults', () => {
    const config = resolve({});
    expect(config.timeout).toBe(120_000);
    expect(config.launchTimeout).toBe(60_000);
    expect(config.actionTimeout).toBe(30_000);
    expect(config.assertionTimeout).toBe(5_000);
    expect(config.cleanupTimeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.tests).toEqual(['tests/**/*.e2e.ts']);
    expect(config.artifacts).toEqual(['screenshot', 'trace']);
    expect(config.reporters).toEqual(['list']);
    expect(config.testIdAttribute).toBe('data-testid');
  });

  it('uses CI defaults for retries and workers', () => {
    const config = resolve({}, { ...BASE_ENV, CI: '1' } as NodeJS.ProcessEnv);
    expect(config.retries).toBe(1);
    expect(config.workers).toBe(1);
  });

  it('creates the implicit web target', () => {
    const config = resolve({});
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0]).toMatchObject({
      name: 'web',
      platform: 'web',
      browser: 'chromium',
      driver: 'playwright',
    });
  });

  it('requires an app URL', () => {
    expect(() => resolveConfig({}, { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv })).toThrow(
      /app URL is required/,
    );
  });

  it('prefers app.url over APP_URL', () => {
    const config = resolve({ app: { url: 'http://127.0.0.1:4000' } });
    expect(config.app.base.origin).toBe('http://127.0.0.1:4000');
  });

  it('rejects unknown top-level and app keys', () => {
    expect(() => resolve({ unknown: true } as never)).toThrow(/unknown config key/);
    expect(() => resolve({ app: { url: 'http://localhost:3000', nope: 1 } } as never)).toThrow(
      /unknown app config key/,
    );
  });

  it('rejects unsupported specVersion values', () => {
    expect(() => resolve({ specVersion: '0.2' } as never)).toThrow(/specVersion/);
  });

  it('rejects defining both top-level browser and explicit targets', () => {
    expect(() =>
      resolve({ browser: 'firefox', targets: [{ name: 'web', platform: 'web' }] }),
    ).toThrow(/browser and explicit targets/);
  });

  it('validates target names and uniqueness', () => {
    expect(() => resolve({ targets: [{ name: 'bad name', platform: 'web' }] })).toThrow(
      /target names/,
    );
    expect(() =>
      resolve({
        targets: [
          { name: 'web', platform: 'web' },
          { name: 'web', platform: 'web' },
        ],
      }),
    ).toThrow(/duplicate target/);
  });

  it('rejects non-web driver targets; backends carry other platforms', () => {
    expect(() =>
      resolve({
        targets: [{ name: 'ios', platform: 'ios', driver: fakeDriver(), app: 'App.app' }],
      } as never),
    ).toThrow(/use a backend target/);
  });

  it('accepts branded third-party drivers and rejects plain objects', () => {
    const driver = fakeDriver();
    const config = resolve({ targets: [{ name: 'custom', platform: 'web', driver }] });
    expect(config.targets[0]!.driver).toBe(driver);
    expect(() =>
      resolve({
        targets: [{ name: 'custom', platform: 'web', driver: { id: 'x' } }],
      } as never),
    ).toThrow(/defineDriver/);
  });

  it('defaults environment to test only for loopback/.localhost/.test hosts', () => {
    expect(resolve({ app: { url: 'https://app.test' } }).app.environment).toBe('test');
    expect(() => resolve({ app: { url: 'https://staging.example.com' } })).toThrow(
      /explicit app.environment/,
    );
    expect(
      resolve({ app: { url: 'https://staging.example.com', environment: 'staging' } }).app
        .environment,
    ).toBe('staging');
  });

  it('rejects production without allowProduction', () => {
    expect(() =>
      resolve({ app: { url: 'https://app.example.com', environment: 'production' } }),
    ).toThrow(/allowProduction/);
    expect(
      resolve({
        app: { url: 'https://app.example.com', environment: 'production', allowProduction: true },
      }).app.allowProduction,
    ).toBe(true);
  });

  it('defaults allowedOrigins to the exact base origin', () => {
    const config = resolve({});
    expect(config.app.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('rejects non-origin allowedOrigins entries', () => {
    expect(() =>
      resolve({ app: { url: 'http://localhost:3000', allowedOrigins: ['http://x.test/path'] } }),
    ).toThrow(/serialized origin/);
  });

  it('rejects json combined with list reporters', () => {
    expect(() => resolve({ reporters: ['json', 'list'] })).toThrow(/json renderer/);
  });

  it('validates numeric bounds', () => {
    expect(() => resolve({ retries: 11 })).toThrow(/retries/);
    expect(() => resolve({ retries: -1 })).toThrow(/retries/);
    expect(() => resolve({ timeout: 0 })).toThrow(/timeout/);
    expect(() => resolve({ workers: 0 })).toThrow(/workers/);
  });

  it('resolves E2E_USER_* environment credentials over config values', () => {
    const config = resolve(
      { credentials: { member: { username: 'config-user', password: 'config-pass' } } },
      {
        ...BASE_ENV,
        E2E_USER_MEMBER_USERNAME: 'env-user',
        E2E_USER_MEMBER_PASSWORD: 'env-pass',
      } as NodeJS.ProcessEnv,
    );
    expect(config.credentials.get('member')).toMatchObject({
      username: 'env-user',
      password: 'env-pass',
    });
  });

  it('replaces credential passwords in the config digest', () => {
    const a = resolve({ credentials: { member: { username: 'u', password: 'secret-1' } } });
    const b = resolve({ credentials: { member: { username: 'u', password: 'secret-2' } } });
    expect(a.configDigest).toBe(b.configDigest);
    const c = resolve({ credentials: { member: { username: 'other', password: 'secret-1' } } });
    expect(a.configDigest).not.toBe(c.configDigest);
  });

  it('replaces app command env values in the config digest', () => {
    const a = resolve({
      app: { url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'aaa' } } },
    });
    const b = resolve({
      app: { url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'bbb' } } },
    });
    expect(a.configDigest).toBe(b.configDigest);
  });
});

function fakeDriver() {
  return defineDriver({
    id: 'fake-driver',
    version: '1.0.0',
    platforms: ['web'],
    spiVersion: 1,
    capabilities: { fixtures: ['web'], artifacts: ['screenshot'], state: false },
    launch: () => Promise.reject(new Error('not implemented')),
  });
}
