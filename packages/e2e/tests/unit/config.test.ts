import { describe, expect, it } from 'vitest';
import { isCiMode, resolveConfig } from '../../src/config/resolve.ts';
import { defineBackend } from '../../src/backend/index.ts';

const ROOT = '/tmp/e2e-config-project';
const BASE_ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;
const WEB = { name: 'web', platform: 'web' } as const;
const TARGETS = [WEB];

function resolve(raw: Parameters<typeof resolveConfig>[0], env: NodeJS.ProcessEnv = BASE_ENV) {
  return resolveConfig({ targets: TARGETS, ...raw }, { projectRoot: ROOT, env });
}

function fakeBackend() {
  return defineBackend({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => ({ nodes: [] }) });
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

  it('applies the config bounds to CLI overrides too', () => {
    expect(() =>
      resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { workers: 0 } }),
    ).toThrow(/--workers must be an integer from 1 through 1024/);
    expect(() =>
      resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { retries: 11 } }),
    ).toThrow(/--retries must be an integer from 0 through 10/);
    expect(
      resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { workers: 3 } }).workers,
    ).toBe(3);
  });

  it('rejects a non-array targets value as INVALID_CONFIG', () => {
    expect(() => resolve({ targets: {} as never })).toThrow(/targets must be a non-empty array/);
  });

  it('uses CI defaults for retries and workers', () => {
    const config = resolve({}, { ...BASE_ENV, CI: '1' } as NodeJS.ProcessEnv);
    expect(config.retries).toBe(1);
    expect(config.workers).toBe(1);
  });

  it('requires explicit targets: core resolves no default backend', () => {
    expect(() => resolveConfig({}, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
      /targets is required/,
    );
    const config = resolve({});
    expect(config.targets[0]).toMatchObject({ name: 'web', platform: 'web', backend: undefined });
  });

  it('tolerates a missing app URL until app.open() needs one', () => {
    const config = resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv });
    expect(config.app.configured).toBe(false);
    expect(() =>
      resolveConfig(
        { targets: TARGETS, app: { command: { executable: 'node' } } },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/app URL is required/);
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

  it('rejects target keys the contract does not know', () => {
    expect(() => resolve({ targets: [{ ...WEB, browser: 'firefox' }] } as never)).toThrow(
      /unknown key "browser"/,
    );
    expect(() => resolve({ targets: [{ ...WEB, driver: 'playwright' }] } as never)).toThrow(
      /unknown key "driver"/,
    );
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

  it('accepts any platform: the backend decides what a target can do', () => {
    const backend = fakeBackend();
    const config = resolve({ targets: [{ name: 'ios', platform: 'ios', backend }] });
    expect(config.targets[0]).toMatchObject({ name: 'ios', platform: 'ios', backend });
    expect(config.targets[0]!.backend?.capabilities.has('observation')).toBe(true);
  });

  it('accepts defineBackend handles and rejects plain objects', () => {
    expect(() =>
      resolve({ targets: [{ ...WEB, backend: { name: 'x', spiVersion: 1 } }] } as never),
    ).toThrow(/defineBackend/);
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

  it('accepts a provider-backed credential password; env override wins over it', () => {
    const provider = () => 'fresh-totp';
    const withProvider = resolve({
      app: { url: 'https://app.test' },
      credentials: { admin: { username: 'admin', password: provider } },
    });
    expect(withProvider.credentials.get('admin')?.password).toBe(provider);
    const overridden = resolve(
      {
        app: { url: 'https://app.test' },
        credentials: { admin: { username: 'admin', password: provider } },
      },
      { E2E_USER_ADMIN_PASSWORD: 'rotated' },
    );
    expect(overridden.credentials.get('admin')?.password).toBe('rotated');
    expect(() =>
      resolve({
        app: { url: 'https://app.test' },
        credentials: { admin: { username: 'admin', password: 42 as never } },
      }),
    ).toThrow(/password must be a non-empty string or a provider function/);
  });

  it('rejects an empty credential password at config time, including an empty env override', () => {
    expect(() =>
      resolve({
        app: { url: 'https://app.test' },
        credentials: { admin: { username: 'admin', password: '' } },
      }),
    ).toThrow(/password must be a non-empty string/);
    expect(() =>
      resolve(
        {
          app: { url: 'https://app.test' },
          credentials: { admin: { username: 'admin', password: 'configured' } },
        },
        { E2E_USER_ADMIN_PASSWORD: '' },
      ),
    ).toThrow(/password must be a non-empty string/);
  });

  it('accepts a stable app.identity and rejects an empty one', () => {
    expect(resolve({ app: { url: 'https://app.test', identity: 'checkout-app' } }).app.identity).toBe(
      'checkout-app',
    );
    expect(resolve({ app: { url: 'https://app.test' } }).app.identity).toBeUndefined();
    expect(() => resolve({ app: { url: 'https://app.test', identity: '  ' } })).toThrow(
      /app.identity must be a non-empty string/,
    );
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

