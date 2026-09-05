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

  it('defaults environment to test for loopback/.localhost/.test hosts and production elsewhere', () => {
    expect(resolve({ app: { url: 'https://app.test' } }).app.environment).toBe('test');
    expect(resolve({ app: { url: 'http://localhost:3000' } }).app.environment).toBe('test');
    expect(resolve({ app: { url: 'https://staging.example.com' } }).app.environment).toBe(
      'production',
    );
    expect(
      resolve({ app: { url: 'https://staging.example.com', environment: 'staging' } }).app
        .environment,
    ).toBe('staging');
    expect(() =>
      resolve({ app: { url: 'https://app.test', environment: 'prod' as never } }),
    ).toThrow(/invalid app.environment/);
  });

  it('accepts a schemeless app URL from config or APP_URL', () => {
    expect(resolve({ app: { url: 'tester.army' } }).app.base.origin).toBe('https://tester.army');
    expect(resolve({ app: { url: 'localhost:3000' } }).app.base.origin).toBe('http://localhost:3000');
    expect(resolve({}, { ...BASE_ENV, APP_URL: 'tester.army' }).app.base.origin).toBe(
      'https://tester.army',
    );
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

  it('rejects the retired allowProduction key like any unknown app key', () => {
    expect(() =>
      resolve({ app: { url: 'https://app.example.com', allowProduction: true } } as never),
    ).toThrow(/unknown app config key "allowProduction"/);
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

  it('accepts the junit reporter beside list or json, and rejects unknown ids', () => {
    expect(resolve({ reporters: ['junit'] }).reporters).toEqual(['junit']);
    expect(resolve({ reporters: ['list', 'junit'] }).reporters).toEqual(['list', 'junit']);
    expect(resolve({ reporters: ['json', 'junit'] }).reporters).toEqual(['json', 'junit']);
    expect(() => resolve({ reporters: ['xunit'] as never })).toThrow(/unknown reporter "xunit"/);
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

  it('rejects an app.readyUrl that is not an http(s) URL', () => {
    expect(() => resolve({ app: { url: 'http://localhost:3000', readyUrl: 'not a url' } })).toThrow(
      /app\.readyUrl must be an http\(s\) URL/,
    );
    expect(() => resolve({ app: { url: 'http://localhost:3000', readyUrl: 'ftp://x/' } })).toThrow(
      /app\.readyUrl must be an http\(s\) URL/,
    );
    expect(
      resolve({ app: { url: 'http://localhost:3000', readyUrl: 'http://localhost:3000/health' } }).app
        .readyUrl,
    ).toBe('http://localhost:3000/health');
  });

  describe('app.services', () => {
    const APP_URL = 'http://localhost:3000';

    it('accepts services with exactly one readiness contract and defaults to none', () => {
      expect(resolve({}).app.services).toEqual([]);
      const config = resolve({
        app: {
          url: APP_URL,
          services: [
            { executable: 'docker', args: ['compose', 'up', '--wait'], waitForExit: true },
            { executable: 'node', args: ['emulator.js'], readyUrl: 'http://127.0.0.1:7000/health' },
          ],
        },
      });
      expect(config.app.services).toHaveLength(2);
      expect(config.app.services[0]?.readiness).toEqual({ waitForExit: true });
      expect(config.app.services[0]?.label).toBe('app.services[0] (docker compose up --wait)');
      expect(config.app.services[1]?.readiness).toEqual({ readyUrl: 'http://127.0.0.1:7000/health' });
      // Runner-only fields are lifted out of the command that gets spawned.
      expect(config.app.services[1]?.command).toEqual({ executable: 'node', args: ['emulator.js'] });
    });

    it('allows services without app.url or app.command', () => {
      const config = resolveConfig(
        { targets: TARGETS, app: { services: [{ executable: 'pnpm', args: ['db:migrate'], waitForExit: true }] } },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      );
      expect(config.app.configured).toBe(false);
      expect(config.app.command).toBeUndefined();
      expect(config.app.services).toHaveLength(1);
    });

    it('rejects a service with neither or both readiness contracts', () => {
      expect(() => resolve({ app: { url: APP_URL, services: [{ executable: 'x' }] } })).toThrow(
        /app\.services\[0\] needs exactly one readiness contract/,
      );
      expect(() =>
        resolve({
          app: {
            url: APP_URL,
            services: [{ executable: 'x', readyUrl: 'http://127.0.0.1:1/', waitForExit: true }],
          },
        }),
      ).toThrow(/app\.services\[0\] needs exactly one readiness contract/);
    });

    it('rejects malformed services', () => {
      expect(() =>
        resolve({ app: { url: APP_URL, services: { executable: 'x' } as unknown as [] } }),
      ).toThrow(/app\.services must be an array/);
      expect(() =>
        resolve({ app: { url: APP_URL, services: [{ executable: '', waitForExit: true }] } }),
      ).toThrow(/app\.services\[0\]\.executable is required/);
      expect(() =>
        resolve({ app: { url: APP_URL, services: [{ executable: 'x', readyUrl: 'not a url' }] } }),
      ).toThrow(/app\.services\[0\]\.readyUrl must be an http\(s\) URL/);
      expect(() =>
        resolve({
          app: {
            url: APP_URL,
            services: [{ executable: 'x', waitForExit: true, teardown: { executable: '' } }],
          },
        }),
      ).toThrow(/app\.services\[0\]\.teardown\.executable is required/);
    });

    it('rejects non-positive-integer timeouts on app.command, services, and teardowns', () => {
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];
      for (const value of bad) {
        expect(() =>
          resolve({ app: { url: APP_URL, command: { executable: 'x', startupTimeout: value } } }),
        ).toThrow(/app\.command\.startupTimeout must be a positive safe integer/);
        expect(() =>
          resolve({
            app: { url: APP_URL, services: [{ executable: 'x', waitForExit: true, startupTimeout: value }] },
          }),
        ).toThrow(/app\.services\[0\]\.startupTimeout must be a positive safe integer/);
        expect(() =>
          resolve({
            app: { url: APP_URL, services: [{ executable: 'x', waitForExit: true, shutdownTimeout: value }] },
          }),
        ).toThrow(/app\.services\[0\]\.shutdownTimeout must be a positive safe integer/);
        expect(() =>
          resolve({
            app: {
              url: APP_URL,
              services: [
                { executable: 'x', waitForExit: true, teardown: { executable: 'y', startupTimeout: value } },
              ],
            },
          }),
        ).toThrow(/app\.services\[0\]\.teardown\.startupTimeout must be a positive safe integer/);
        expect(() =>
          resolve({
            app: {
              url: APP_URL,
              services: [
                { executable: 'x', waitForExit: true, teardown: { executable: 'y', shutdownTimeout: value } },
              ],
            },
          }),
        ).toThrow(/app\.services\[0\]\.teardown\.shutdownTimeout must be a positive safe integer/);
      }
      const ok = resolve({
        app: {
          url: APP_URL,
          command: { executable: 'x', startupTimeout: 1, shutdownTimeout: 1 },
          services: [
            {
              executable: 'x',
              waitForExit: true,
              startupTimeout: 5_000,
              shutdownTimeout: 500,
              teardown: { executable: 'y', startupTimeout: 5_000, shutdownTimeout: 500 },
            },
          ],
        },
      });
      expect(ok.app.services[0]?.teardown?.command.startupTimeout).toBe(5_000);
      expect(ok.app.services[0]?.teardown?.label).toBe('app.services[0] (x) teardown (y)');
    });

    it('replaces service and teardown env values in the config digest', () => {
      const services = (secret: string) => [
        {
          executable: 'docker',
          args: ['compose', 'up', '--wait'],
          waitForExit: true,
          env: { POSTGRES_PASSWORD: secret },
          teardown: { executable: 'docker', args: ['compose', 'down'], env: { POSTGRES_PASSWORD: secret } },
        },
      ];
      const a = resolve({ app: { url: APP_URL, services: services('aaa') } });
      const b = resolve({ app: { url: APP_URL, services: services('bbb') } });
      expect(a.configDigest).toBe(b.configDigest);
      const renamed = resolve({
        app: { url: APP_URL, services: [{ ...services('aaa')[0]!, env: { PGPASSWORD: 'aaa' } }] },
      });
      expect(renamed.configDigest).not.toBe(a.configDigest);
    });
  });

  describe('artifacts config', () => {
    const APP = { app: { url: 'https://app.test' } };
    it('defaults kinds and leaves the store unset for the array form', () => {
      const resolved = resolve({ ...APP });
      expect(resolved.artifacts).toEqual(['screenshot', 'trace']);
      expect(resolved.artifactsExplicit).toBe(false);
      expect(resolved.artifactStore).toBeUndefined();
      expect(resolve({ ...APP, artifacts: ['trace'] }).artifactsExplicit).toBe(true);
    });

    it('accepts { kinds, store } and keeps the live store out of the digest', () => {
      const store = { put: async () => ({ ref: 'x' }) };
      const withStore = resolve({ ...APP, artifacts: { kinds: ['screenshot'], store } });
      expect(withStore.artifacts).toEqual(['screenshot']);
      expect(withStore.artifactsExplicit).toBe(true);
      expect(withStore.artifactStore).toBe(store);
      // Same kinds, with and without a store, digest identically: the store is
      // a live value, not configuration.
      expect(withStore.configDigest).toBe(resolve({ ...APP, artifacts: ['screenshot'] }).configDigest);
      // A store alone keeps the default kinds and is not "explicit".
      const storeOnly = resolve({ ...APP, artifacts: { store } });
      expect(storeOnly.artifacts).toEqual(['screenshot', 'trace']);
      expect(storeOnly.artifactsExplicit).toBe(false);
    });

    it('rejects unknown keys, a non-store store, and unknown kinds in either form', () => {
      expect(() => resolve({ ...APP, artifacts: { kinds: ['trace'], ttl: 1 } as never })).toThrow(
        /unknown artifacts config key "ttl"/,
      );
      expect(() => resolve({ ...APP, artifacts: { store: { upload: true } } as never })).toThrow(
        /artifacts.store must implement ArtifactStore/,
      );
      expect(() => resolve({ ...APP, artifacts: { kinds: ['video'] } as never })).toThrow(
        /unknown artifact kind "video"/,
      );
      expect(() => resolve({ ...APP, artifacts: ['video'] as never })).toThrow(/unknown artifact kind "video"/);
    });
  });
});
