import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverConfig } from '../../src/config/load.ts';
import { isCiMode, resolveConfig } from '../../src/config/resolve.ts';
import { ConfigurationError, defineEngine } from '../../src/engine/index.ts';
import { secrets } from '../../src/secrets.ts';
import type { CommandConfig, E2EConfig, Target, TargetApp } from '../../src/types.ts';
import { TRACE_REMOVED, TRACE_REPLACEMENT } from '../../src/internal/recording-modes.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { invalid } from '../helpers/invalid.ts';

const ROOT = '/tmp/e2e-config-project';
const BASE_ENV = {} as NodeJS.ProcessEnv;
const WEB = { name: 'web', platform: 'web' } as const;
const TARGETS = [WEB];

function resolve(raw: Partial<E2EConfig>, env: NodeJS.ProcessEnv = BASE_ENV) {
  return resolveConfig({ targets: TARGETS, ...raw }, { projectRoot: ROOT, env });
}

/** A minimal observing engine, the way web() or mobile() would drive a target. */
function fakeEngine() {
  return defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) });
}

/** One web target on the fake engine declaring `app`. */
function declaredTarget(app: TargetApp = {}): Target {
  return { ...WEB, engine: fakeEngine(), app };
}

/** Resolves one web target declaring `app`, and returns the resolved app. */
function resolveApp(app: TargetApp = {}) {
  return resolve({ targets: [declaredTarget(app)] }).targets[0]!.app;
}

/** The one web target's `app.command`, expanded, with the URL it is probed at. */
function commandOf(app: TargetApp, projectRoot = ROOT): { readonly command: CommandConfig; readonly readiness: { readonly readyUrl: string } } {
  const resolved = resolveConfig({ targets: [declaredTarget(app)] }, { projectRoot, env: BASE_ENV }).targets[0]!.app;
  if (resolved.command === undefined || resolved.readyUrl === undefined) throw new Error('the target declares no app.command');
  return { command: resolved.command, readiness: { readyUrl: resolved.readyUrl } };
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
  it('validates the opt-in skip failure policy without invalidating recordings', () => {
    expect(resolve({}).failOnSkippedFailure).toBe(false);
    expect(resolve({ failOnSkippedFailure: true }).failOnSkippedFailure).toBe(true);
    expect(resolve({ failOnSkippedFailure: false }).failOnSkippedFailure).toBe(false);
    expect(resolve({ failOnSkippedFailure: true }).configDigest).toBe(resolve({}).configDigest);
    for (const value of ['true', 1, null, {}]) {
      expect(() => resolve(invalid({ failOnSkippedFailure: value }))).toThrow(/failOnSkippedFailure must be a boolean/);
    }
  });

  it('applies specification defaults', () => {
    const config = resolve({});
    expect(config.timeout).toBe(120_000);
    expect(config.launchTimeout).toBe(60_000);
    expect(config.actionTimeout).toBe(30_000);
    expect(config.assertionTimeout).toBe(5_000);
    expect(config.cleanupTimeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.tests).toEqual(['tests/**/*.e2e.ts']);
    expect(config.targets[0]!.video).toEqual({ mode: 'off', source: 'default' });
    expect(config.reporters).toEqual(['list']);
  });

  it('validates tests as globs at resolution, not at collection', () => {
    /** The code and message of the error `resolve` throws for `raw`. */
    const failure = (raw: Partial<E2EConfig>): { code: string; message: string } => {
      try {
        resolve(raw);
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error('resolved');
    };
    const shape = 'tests must be a glob or a list of globs relative to the project root';
    expect(failure({ tests: 5 } as never)).toMatchObject({ code: 'INVALID_CONFIG', message: `${shape}, got 5` });
    expect(failure({ tests: {} } as never)).toMatchObject({ code: 'INVALID_CONFIG', message: `${shape}, got an object` });
    expect(failure({ tests: [1] } as never)).toMatchObject({ code: 'INVALID_CONFIG', message: `${shape}, got 1 in the list` });
    expect(failure({ tests: '' })).toMatchObject({ code: 'INVALID_CONFIG', message: `${shape}, got "" in the list` });
    expect(failure({ tests: [] })).toMatchObject({ code: 'INVALID_CONFIG', message: 'tests must not be empty' });
    expect(failure({ tests: ['tests/**foo/*.ts'] })).toMatchObject({
      code: 'INVALID_GLOB',
      message: "'**' must be a complete path segment: tests/**foo/*.ts",
    });
    expect(failure({ tests: ['!tests/wip/**'] })).toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'tests has only "!" exclusions, which select nothing; add a glob that selects files, such as ["tests/**/*.e2e.ts", "!tests/wip/**"]',
    });
    expect(failure({ tests: '!tests/wip/**' })).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(failure({ tests: ['tests/**/*.e2e.ts', '!tests/{a,b}/**'] })).toMatchObject({ code: 'INVALID_GLOB' });
    expect(resolve({ tests: ['tests/**/*.e2e.ts', '!tests/wip/**'] }).tests).toEqual(['tests/**/*.e2e.ts', '!tests/wip/**']);
    expect(resolve({ tests: 'e2e/*.e2e.ts' }).tests).toEqual(['e2e/*.e2e.ts']);
    expect(resolve({ tests: ['tests/**/*.e2e.ts', 'tests/**/*.e2e.ts', 'e2e/*.e2e.ts'] }).tests).toEqual([
      'tests/**/*.e2e.ts',
      'e2e/*.e2e.ts',
    ]);
  });

  it('refuses a wildcard-free tests entry that names a directory, which a glob would read as a file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tests-dir-'));
    const resolveIn = (tests: string[]) => resolveConfig({ targets: TARGETS, tests }, { projectRoot: root, env: BASE_ENV });
    try {
      fs.mkdirSync(path.join(root, 'tests', 'wip'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tests', 'wip', 'a.e2e.ts'), '');
      expect(() => resolveIn(['tests/**/*.e2e.ts', '!tests/wip'])).toThrow(
        expect.objectContaining({
          code: 'INVALID_GLOB',
          message: 'tests entry "!tests/wip" names a directory, and a glob names files, so it excludes nothing; write "!tests/wip/**" to exclude everything under it',
        }),
      );
      expect(() => resolveIn(['./tests'])).toThrow(
        expect.objectContaining({
          code: 'INVALID_GLOB',
          message: 'tests entry "./tests" names a directory, and a glob names files, so it selects nothing; write "tests/**/*.e2e.ts" to select the test files under it',
        }),
      );
      expect(resolveIn(['tests/**/*.e2e.ts', '!tests/wip/**']).tests).toEqual(['tests/**/*.e2e.ts', '!tests/wip/**']);
      expect(resolveIn(['tests/**/*.e2e.ts', '!tests/wip/a.e2e.ts', '!tests/gone']).tests).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('uses CI defaults for retries, workers, and video', () => {
    const config = resolve({}, { ...BASE_ENV, CI: '1' } as NodeJS.ProcessEnv);
    expect(config.retries).toBe(1);
    expect(config.workers).toBe(1);
    expect(config.targets[0]!.video).toEqual({ mode: 'off', source: 'default' });
  });

  it('requires explicit targets: core resolves no default engine', () => {
    // The type already demands targets; the loader still guards a config written in JavaScript.
    expect(() => resolveConfig({} as E2EConfig, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
      /targets is required/,
    );
    expect(() => resolve({ targets: {} as never })).toThrow(/targets must be a non-empty array/);
    const config = resolve({});
    expect(config.targets[0]).toMatchObject({ name: 'web', platform: 'web', engine: undefined });
  });

  it('resolves the empty app for a target that declares none', () => {
    expect(resolve({}).targets[0]!.app).toEqual({
      base: undefined,
      site: undefined,
      environment: 'test',
      identity: undefined,
    });
    expect(resolveApp().base).toBeUndefined();
  });

  it('resolves the URL a target declares and rejects the retired top-level app key', () => {
    const app = resolveApp({ url: 'http://127.0.0.1:4000' });
    expect(app.base?.origin).toBe('http://127.0.0.1:4000');
    expect(app.base?.href).toBe('http://127.0.0.1:4000/');
    expect(() => resolve({ app: { url: 'http://127.0.0.1:4000' } } as never)).toThrow(/unknown config key "app"/);
    expect(() => resolve({ unknown: true } as never)).toThrow(/unknown config key/);
  });

  it('suggests the nearest key and points foreign keys at where the fact lives', () => {
    expect(() => resolve({ target: [] } as never)).toThrow('unknown config key "target"; did you mean "targets"?');
    expect(() => resolve({ testDir: 'tests' } as never)).toThrow(
      'unknown config key "testDir"; test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
    );
    expect(() => resolve({ targets: [{ ...WEB, engine: 'playwright' }] } as never)).toThrow(
      'target "web" engine must be an engine handle, got the string "playwright"; call the engine\'s factory',
    );
  });

  it('names the unit and the offending value for durations', () => {
    expect(() => resolve({ timeout: '30s' } as never)).toThrow(
      'timeout must be a positive safe integer of milliseconds, got "30s"',
    );
    expect(() => resolve({ launchTimeout: 0 })).toThrow('launchTimeout must be a positive safe integer of milliseconds, got 0');
  });

  it('accepts a command only beside a URL to poll, and defaults readyUrl to it', () => {
    expect(() => resolveApp({ command: { executable: 'node' } })).toThrow(/without a URL to poll/);
    expect(commandOf({ url: 'http://localhost:3000', command: { executable: 'node' } })).toMatchObject({
      command: { executable: 'node' },
      readiness: { readyUrl: 'http://localhost:3000/' },
    });
    expect(commandOf({ command: { executable: 'node' }, readyUrl: 'http://localhost:9/health' }).readiness).toEqual({
      readyUrl: 'http://localhost:9/health',
    });
    expect(() => resolveApp({ url: 'http://localhost:3000', command: { executable: '' } })).toThrow(
      /command.executable is required/,
    );
  });

  it('takes only strings in a command\'s args and env, naming secrets.get() for a handle', () => {
    const url = 'http://localhost:3000';
    expect(() => resolveApp({ url, command: { executable: 'node', args: ['server.mjs', 3000] } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" app.command.args[1] must be a string, got 3000' }),
    );
    expect(commandOf({ url, command: { executable: 'node', env: { PORT: '3000', UNSET: undefined } } } as never).command.env).toEqual({
      PORT: '3000',
    });
    expect(() => resolveApp({ url, command: { executable: 'node', env: ['PORT=3000'] } } as never)).toThrow(
      'target "web" app.command.env must be an object of variable name to string',
    );
    expect(() => resolveApp({ url, command: { executable: 'node', env: { PORT: 3000 } } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" app.command.env.PORT must be a string, got 3000' }),
    );
    expect(() => resolveApp({ url, command: { executable: 'node', env: { API_KEY: secrets.get('API_KEY') } } } as never)).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: expect.stringMatching(/^target "web" app\.command\.env\.API_KEY must be a string, got secrets\.get\("API_KEY"\): only an engine option that declares secrets/),
      }),
    );
    expect(() => resolveApp({ url: secrets.get('url') } as never)).toThrow(/^target "web" app\.url must be a non-empty string/);
    expect(() => `--token=${String(secrets.get('db'))}`).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('secrets.get("db") is a reference to a secret, not its value') }),
    );
  });

  it('rejects an app or command key the contract does not know, naming the nearest', () => {
    const url = 'http://localhost:3000';
    expect(() => resolveApp({ url, readyURL: url } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" app has unknown key "readyURL"; did you mean "readyUrl"?' }),
    );
    expect(() => resolveApp({ url, command: { executable: 'node', arg: ['server.mjs'] } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" app.command has unknown key "arg"; did you mean "args"?' }),
    );
    expect(() => resolveApp({ url, command: { executable: 'node', readyUrl: url } } as never)).toThrow(
      /app\.command has unknown key "readyUrl"; expected one of executable, args, cwd, env, startupTimeout, shutdownTimeout, log, reuseExisting$/,
    );
  });

  it('defaults a target name to its platform', () => {
    const engine = fakeEngine();
    expect(resolve({ targets: [{ platform: 'ios', engine }] }).targets[0]).toMatchObject({ name: 'ios', platform: 'ios', engine });
    expect(resolve({ targets: [{ platform: 'ios' }, { platform: 'android' }] }).targets.map((target) => target.name)).toEqual([
      'ios',
      'android',
    ]);
  });

  it('validates target names and uniqueness, defaulted names included', () => {
    expect(() => resolve({ targets: [{ name: 'bad name', platform: 'web' }] })).toThrow(
      'invalid target name "bad name"; target names are limited to ASCII letters, numbers, "_", "-", and "."',
    );
    expect(() => resolve({ targets: [{ platform: 'bad name' }] })).toThrow(
      'invalid target name "bad name" (defaulted from the platform)',
    );
    // `.` and `..` pass the alphabet and are path segments: a target named `..` would write beside `report.json`.
    for (const dots of ['.', '..', '...']) {
      expect(() => resolve({ targets: [{ name: dots, platform: 'web' }] })).toThrow(
        `invalid target name "${dots}"; target names are limited to ASCII letters, numbers, "_", "-", and ".", and cannot be only dots`,
      );
    }
    expect(resolve({ targets: [{ name: '.hidden', platform: 'web' }, { name: 'v1.2', platform: 'web' }] }).targets.map((target) => target.name)).toEqual(['.hidden', 'v1.2']);
    expect(() =>
      resolve({
        targets: [
          { name: 'web', platform: 'web' },
          { name: 'web', platform: 'web' },
        ],
      }),
    ).toThrow(/duplicate target name "web"$/);
    const hint = 'a target without a name is named after its platform, so name one of them';
    expect(() => resolve({ targets: [{ platform: 'ios' }, { platform: 'ios' }] })).toThrow(`duplicate target name "ios"; ${hint}`);
    expect(() => resolve({ targets: [{ name: 'web', platform: 'ios' }, { platform: 'web' }] })).toThrow(
      `duplicate target name "web"; ${hint}`,
    );
    expect(() => resolve({ targets: [{ platform: 'web' }, { name: 'web', platform: 'ios' }] })).toThrow(
      `duplicate target name "web"; ${hint}`,
    );
  });

  it('points at the entry when a target has no name to report under', () => {
    expect(() => resolve({ targets: [{ engine: fakeEngine() }] } as never)).toThrow(
      'targets[0] needs a platform: engine fake declares none; set platform on the target',
    );
    expect(() => resolve({ targets: [{ platform: 'ios', browser: 'x' }] } as never)).toThrow('targets[0] has unknown key "browser"');
    expect(() => resolve({ targets: [{ name: 'ios' }] } as never)).toThrow(
      'target "ios" needs a platform: it has no engine to inherit one from; set platform on the target',
    );
  });

  it('inherits the platform the engine declares, and the name follows', () => {
    const ios = defineEngine({ name: 'fake-ios', version: '1.0.0', spiVersion: 1, platform: 'ios' });
    expect(resolve({ targets: [{ engine: ios }] }).targets[0]).toMatchObject({ name: 'ios', platform: 'ios' });
    expect(resolve({ targets: [{ name: 'phone', engine: ios }] }).targets[0]).toMatchObject({ name: 'phone', platform: 'ios' });
    expect(resolve({ targets: [{ platform: 'ios', engine: ios }] }).targets[0]).toMatchObject({ name: 'ios', platform: 'ios' });
  });

  it('rejects a target platform that disagrees with its engine, and a target with no platform to inherit', () => {
    const ios = defineEngine({ name: 'fake-ios', version: '1.0.0', spiVersion: 1, platform: 'ios' });
    expect(() => resolve({ targets: [{ name: 'phone', platform: 'iphone-17', engine: ios }] })).toThrow(
      'target "phone" declares platform "iphone-17" but its engine fake-ios drives "ios"; drop the target\'s platform or make them agree',
    );
  });

  it('accepts defineEngine handles and rejects plain objects', () => {
    expect(() =>
      resolve({ targets: [{ ...WEB, engine: { name: 'x', spiVersion: 1 } }] } as never),
    ).toThrow(/defineEngine/);
  });

  it('defaults environment to test for loopback/.localhost/.test hosts and production elsewhere', () => {
    expect(resolveApp({ url: 'https://app.test' }).environment).toBe('test');
    expect(resolveApp({ url: 'http://localhost:3000' }).environment).toBe('test');
    expect(resolveApp({ url: 'https://staging.example.com' }).environment).toBe('production');
    expect(resolveApp({ url: 'https://staging.example.com', environment: 'staging' }).environment).toBe('staging');
    expect(resolveApp({ environment: 'staging' }).environment).toBe('staging');
    expect(() => resolveApp({ url: 'https://app.test', environment: 'prod' as never })).toThrow(
      /app.environment must be one of/,
    );
  });

  it('accepts a schemeless declared URL', () => {
    expect(resolveApp({ url: 'tester.army' }).base?.origin).toBe('https://tester.army');
    expect(resolveApp({ url: 'localhost:3000' }).base?.origin).toBe('http://localhost:3000');
  });

  it('accepts a provider-backed credential password; env override wins over it', () => {
    const provider = () => 'fresh-totp';
    const withProvider = resolve({
      credentials: { admin: { username: 'admin', password: provider } },
    });
    expect(withProvider.credentials.get('admin')?.password).toMatchObject({ purpose: 'password', value: provider });
    const overridden = resolve(
      {
        credentials: { admin: { username: 'admin', password: provider } },
      },
      { E2E_USER_ADMIN_PASSWORD: 'rotated' },
    );
    expect(overridden.credentials.get('admin')?.password.value).toBe('rotated');
    expect(() =>
      resolve({
        credentials: { admin: { username: 'admin', password: 42 as never } },
      }),
    ).toThrow(/password must be a non-empty string or a provider function/);
  });

  it('rejects a credential username that is not a string, an unknown credential key, and a non-object credential', () => {
    expect(() =>
      resolve({
        credentials: { admin: { username: (() => 'admin') as never, password: 'admin-pass' } },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: 'credential "admin" username must be a string, got a function; only password may be a provider function',
      }),
    );
    expect(() =>
      resolve({
        credentials: { admin: { username: 'admin', password: 'admin-pass', usename: 'admin' } as never },
      }),
    ).toThrow(/unknown key "usename" in credential "admin"; a credential has username and password; did you mean "username"\?/);
    expect(() => resolve({ credentials: { admin: null as never } })).toThrow(
      /credential "admin" must be an object of \{ username, password \}, got null/,
    );
  });

  it('takes a username missing from the config from E2E_USER_<NAME>_USERNAME, and rejects one missing from both', () => {
    const credentials = { admin: { username: undefined as never, password: 'admin-pass' } };
    expect(resolve({ credentials }, { E2E_USER_ADMIN_USERNAME: 'from-env' }).credentials.get('admin')?.username).toBe('from-env');
    expect(() => resolve({ credentials })).toThrow(/credential "admin" has no username; set username or E2E_USER_ADMIN_USERNAME/);
  });

  it('rejects an empty credential password at config time, including an empty env override', () => {
    expect(() =>
      resolve({
        credentials: { admin: { username: 'admin', password: '' } },
      }),
    ).toThrow(/password must be a non-empty string/);
    expect(() =>
      resolve(
        {
          credentials: { admin: { username: 'admin', password: 'configured' } },
        },
        { E2E_USER_ADMIN_PASSWORD: '' },
      ),
    ).toThrow(/password must be a non-empty string/);
  });

  it('keys identity on the declared identity, else the URL origin and path, else the bundle id or build, else nothing', () => {
    expect(resolveApp({ url: 'https://app.test', identity: 'checkout-app' }).identity).toBe('checkout-app');
    expect(resolveApp({ url: 'https://app.test/shop/' }).identity).toBe('https://app.test/shop/');
    expect(resolveApp({ identity: 'com.example.app' }).identity).toBe('com.example.app');
    expect(resolveApp({ bundleId: 'dev.shop.app', appPath: './build/Shop.app' }).identity).toBe('dev.shop.app');
    expect(resolveApp({ appPath: './build/shop.apk' }).identity).toBe('./build/shop.apk');
    expect(resolveApp().identity).toBeUndefined();
    expect(() => resolveApp({ url: 'https://app.test', identity: '  ' })).toThrow(
      /app.identity must be a non-empty string/,
    );
  });

  it('rejects unknown app keys on the target, naming the nearest', () => {
    expect(() => resolveApp({ allowProduction: true } as never)).toThrow(/target "web" app has unknown key "allowProduction"/);
    expect(() => resolveApp({ bundleID: 'x' } as never)).toThrow('did you mean "bundleId"?');
    expect(() => resolve({ targets: [{ ...WEB, app: { services: [] } }] } as never)).toThrow('target "web" app has unknown key "services"');
  });

  it('checks the shape of every app field', () => {
    expect(() => resolveApp({ url: 5 } as never)).toThrow('target "web" app.url must be a non-empty string');
    expect(() => resolveApp({ bundleId: '' })).toThrow('app.bundleId must be a non-empty string');
    expect(() => resolveApp({ appPath: ' ' })).toThrow('app.appPath must be a non-empty string');
    expect(() => resolveApp({ launchArguments: ['-a', 1] } as never)).toThrow('app.launchArguments must be an array of strings');
    expect(() => resolveApp({ permissions: { camera: 'allow' } } as never)).toThrow(
      'app.permissions.camera must be grant, deny, or reset, got "allow"',
    );
    expect(() => resolve({ targets: [{ ...WEB, app: 'https://app.test' }] } as never)).toThrow('target "web" app must be an object');
    expect(() => resolve({ targets: [{ ...WEB, app: { url: 'https://app.test' } }] })).toThrow(
      'target "web" declares app without an engine',
    );
    // A value read from the environment may be undefined: that is the key left out.
    expect(resolveApp({ bundleId: 'dev.shop.app', appPath: undefined, identity: undefined }).identity).toBe('dev.shop.app');
    expect(resolveApp({ bundleId: 'dev.shop.app', launchArguments: ['-e2e'], permissions: { camera: 'grant' } })).toMatchObject({
      bundleId: 'dev.shop.app',
      launchArguments: ['-e2e'],
      permissions: { camera: 'grant' },
    });
  });

  it("hands the declaration to the engine's validateApp, which names the target", () => {
    const seen: unknown[] = [];
    const strict = defineEngine({
      name: 'strict',
      version: '1.0.0',
      spiVersion: 1,
      validateApp(app, { targetName }) {
        seen.push(app);
        if (app.url === undefined) throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}" needs app.url`);
      },
    });
    expect(() => resolve({ targets: [{ ...WEB, engine: strict }] })).toThrow('target "web" needs app.url');
    resolve({ targets: [{ ...WEB, engine: strict, app: { url: 'https://app.test', command: { executable: 'node' }, readyUrl: 'https://app.test/up' } }] });
    expect(seen).toEqual([{}, { url: 'https://app.test' }]);
  });

  it('derives the site from the base URL, or none without one', () => {
    expect(resolveApp({ url: 'http://localhost:3000/app' }).site).toBe('localhost');
    expect(resolveApp({ url: 'https://app.staging.example.com' }).site).toBe('example.com');
    expect(resolveApp().site).toBeUndefined();
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

  it('accepts reporter objects beside the ids and keeps them under --reporter', () => {
    const upload = { name: 'upload', onRunFinished: async () => undefined };
    const config = resolve({ reporters: ['list', upload] });
    expect(config.reporters).toEqual(['list']);
    expect(config.customReporters).toEqual([upload]);
    const overridden = resolveConfig(
      { targets: TARGETS, reporters: ['list', upload] },
      { projectRoot: ROOT, env: BASE_ENV, cli: { reporters: ['junit'] } },
    );
    expect(overridden.reporters).toEqual(['junit']);
    expect(overridden.customReporters).toEqual([upload]);
    // Objects alone leave the terminal silent, as `['junit']` does.
    expect(resolve({ reporters: [upload] }).reporters).toEqual([]);
  });

  it('rejects a reporter object without a name or a handler', () => {
    const handler = async () => undefined;
    expect(() => resolve({ reporters: [{ onRunFinished: handler }] as never })).toThrow(/object with a name/);
    expect(() => resolve({ reporters: [{ name: '', onRunFinished: handler }] as never })).toThrow(/object with a name/);
    expect(() => resolve({ reporters: [{ name: 'x' }] as never })).toThrow(/object with a name/);
    expect(() => resolve({ reporters: [{ name: 'x', onEvent: 'no' }] as never })).toThrow(/object with a name/);
  });

  it('keeps reporter objects and artifact stores out of the config digest, whatever they hold', () => {
    // A client with a cycle is what an SDK-backed reporter or store carries; JSON cannot clone it.
    const client: Record<string, unknown> = {};
    client['self'] = client;
    const upload = { name: 'upload', client, onRunFinished: async () => undefined };
    expect(resolve({ reporters: ['list', upload] }).configDigest).toBe(resolve({ reporters: ['list'] }).configDigest);
    const store = { client, put: async () => ({ ref: 'r' }) };
    expect(resolve({ artifacts: { store } }).configDigest).toBe(resolve({}).configDigest);
  });

  it('reduces every model instance in an agent entry to its identity, judge and a custom executor\'s own included', () => {
    // A provider client with a cycle: JSON cannot clone it, and its settings
    // must never enter the digest anyway.
    const client: Record<string, unknown> = {};
    client['self'] = client;
    const instance = (modelId: string) =>
      ({
        specificationVersion: 'v4',
        provider: 'openai',
        modelId,
        client,
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error('not called')),
        doStream: () => Promise.reject(new Error('not called')),
      }) as never;
    const withJudge = resolve({ agents: { default: { model: instance('actor'), judge: instance('verifier') } } });
    expect(withJudge.configDigest).toBe(
      resolve({ agents: { default: { model: instance('actor'), judge: instance('verifier') } } }).configDigest,
    );
    expect(withJudge.configDigest).not.toBe(
      resolve({ agents: { default: { model: instance('actor'), judge: instance('other') } } }).configDigest,
    );
    const brain = () => ({ name: 'brain', runStep: () => Promise.reject(new Error('not called')), model: instance('actor'), judge: instance('verifier') });
    const asExecutor = resolve({ agents: { default: { executor: brain() } } });
    expect(asExecutor.configDigest).toBe(resolve({ agents: { default: { executor: brain() } } }).configDigest);
  });

  it('checks every secret an engine option holds against the configured secrets, never a credential', () => {
    const engine = (name: string) =>
      defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), secrets: [secrets.get(name)] });
    const declared = { secrets: { stagingPassword: 'staging-pass' }, credentials: { admin: { username: 'admin', password: 'admin-pass' } } };
    expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine('stagingPassword') }] })).not.toThrow();
    for (const name of ['admin', 'admin.password']) {
      expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine(name) }] })).toThrow(
        expect.objectContaining({
          code: 'INVALID_CONFIG',
          message: expect.stringContaining(
            `uses secrets.get("${name}"), which is not configured; add it to config.secrets; credential "admin" is not a secrets entry, and an engine option takes one: declare the value under config.secrets`,
          ),
        }),
      );
    }
    expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine('stagingPasword') }] })).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message:
          'target "web" engine fake uses secrets.get("stagingPasword"), which is not configured; add it to config.secrets; did you mean "stagingPassword"?',
      }),
    );
  });

  it('keeps an engine option\'s secret out of the config digest', () => {
    const engine = defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), secrets: [secrets.get('key')] });
    const digest = (value: string) => resolve({ secrets: { key: value }, targets: [{ ...WEB, engine }] }).configDigest;
    expect(digest('first-value')).toBe(digest('second-value'));
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
    expect(config.credentials.get('member')).toMatchObject({ username: 'env-user' });
    expect(config.allSecrets.get('member.password')?.value).toBe('env-pass');
  });

  it('resolves config.secrets as generic secrets: values, providers, origin narrowing, and E2E_SECRET_* overrides', () => {
    const provider = () => 'fresh';
    const config = resolve(
      {
        secrets: {
          'stripe-key': 'sk_test_123',
          totp: provider,
          rotated: 'stale',
        },
      },
      { ...BASE_ENV, E2E_SECRET_ROTATED: 'fresh-from-env' } as NodeJS.ProcessEnv,
    );
    expect(config.secrets.get('stripe-key')).toEqual({ name: 'stripe-key', purpose: 'generic-secret', value: 'sk_test_123' });
    expect(config.secrets.get('totp')?.value).toBe(provider);
    expect(config.secrets.get('rotated')?.value).toBe('fresh-from-env');
  });

  it('rejects an empty or non-string secret and a secret named like a password handle, but lets a secret share a credential name', () => {
    expect(() => resolve({ secrets: { key: '' } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: 42 as never } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: { value: 'v' } as never } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: 'v' } }, { ...BASE_ENV, E2E_SECRET_KEY: '' } as NodeJS.ProcessEnv)).toThrow(/secret "key" must be/);
    const shared = resolve({ credentials: { admin: { username: 'u', password: 'password-1' } }, secrets: { admin: 'value-1' } });
    expect(shared.secrets.get('admin')).toMatchObject({ purpose: 'generic-secret', value: 'value-1' });
    expect(shared.credentials.get('admin')?.password).toMatchObject({ name: 'admin.password', purpose: 'password', value: 'password-1' });
    expect([...shared.allSecrets.keys()]).toEqual(['admin.password', 'admin']);
    expect([...shared.secrets.keys()]).toEqual(['admin']);
    expect(() =>
      resolve({ credentials: { admin: { username: 'u', password: 'password-1' } }, secrets: { 'admin.password': 'value-1' } }),
    ).toThrow(/secret "admin.password" has the name of credential "admin"'s password handle; rename the secret/);
  });

  it('refuses two secrets that share an E2E_SECRET_* variable, naming the entries and never a value, whether or not it is set', () => {
    const values = ['secret-value-a1', 'secret-value-b2', 'secret-value-c3'];
    const colliding = { 'api-key': values[0]!, api_key: values[1]! };
    for (const env of [BASE_ENV, { ...BASE_ENV, E2E_SECRET_API_KEY: 'rotated-value-z9' } as NodeJS.ProcessEnv]) {
      let error: unknown;
      try {
        resolve({ secrets: colliding }, env);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
      const message = (error as Error).message;
      expect(message).toBe(
        'secrets "api-key" and "api_key" share the override variable E2E_SECRET_API_KEY, so one value set there would replace all of them; rename all but one',
      );
      for (const value of [...values, 'rotated-value-z9']) expect(message).not.toContain(value);
    }
    expect(() => resolve({ secrets: { 'api.key': values[0]!, 'API-KEY': values[1]!, apikey: values[2]! } })).toThrow(
      /^secrets "api\.key" and "API-KEY" share the override variable E2E_SECRET_API_KEY/,
    );
    expect(() => resolve({ secrets: { 'a-b': values[0]!, a_b: values[1]!, 'a.b': values[2]! } })).toThrow(
      /^secrets "a-b", "a_b" and "a\.b" share/,
    );
    expect(() => resolve({ secrets: { 'pk-live': () => 'from-provider', pk_live: values[0]! } })).toThrow(/E2E_SECRET_PK_LIVE/);
  });

  it('refuses two credentials that share E2E_USER_* variables, naming the entries and never a value', () => {
    const credential = (password: string) => ({ username: 'user@example.test', password });
    let error: unknown;
    try {
      resolve({ credentials: { 'svc-a': credential('password-one-1'), svc_a: credential('password-two-2') } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
    const message = (error as Error).message;
    expect(message).toBe(
      'credentials "svc-a" and "svc_a" share the override variables E2E_USER_SVC_A_USERNAME and E2E_USER_SVC_A_PASSWORD, so one value set there would replace all of them; rename all but one',
    );
    expect(message).not.toMatch(/password-one-1|password-two-2|user@example\.test/);
  });

  it('keeps E2E_USER_* and E2E_SECRET_* apart and accepts punctuation that maps to a distinct variable', () => {
    const config = resolve(
      {
        credentials: { 'svc-a': { username: 'u', password: 'password-1' }, 'svc-b': { username: 'u', password: 'password-2' } },
        secrets: { 'svc-a': 'secret-value-1', 'stripe.key': 'secret-value-2', 'stripe-key-2': 'secret-value-3' },
      },
      { ...BASE_ENV, E2E_SECRET_STRIPE_KEY: 'rotated-stripe', E2E_USER_SVC_A_PASSWORD: 'rotated-password' } as NodeJS.ProcessEnv,
    );
    expect(config.secrets.get('stripe.key')?.value).toBe('rotated-stripe');
    expect(config.secrets.get('stripe-key-2')?.value).toBe('secret-value-3');
    expect(config.secrets.get('svc-a')?.value).toBe('secret-value-1');
    expect(config.allSecrets.get('svc-a.password')?.value).toBe('rotated-password');
    expect(config.allSecrets.get('svc-b.password')?.value).toBe('password-2');
  });

  it('refuses a static secret or password under 6 code points, from config or the environment, naming the minimum', () => {
    expect(() => resolve({ secrets: { pin: '12345' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolve({ secrets: { pin: '12345' } })).toThrow(
      /secret "pin" must be at least 6 characters \(code points\), not 5; a shorter value cannot be redacted without rewriting unrelated text/,
    );
    expect(() => resolve({ secrets: { pin: '123456' } })).not.toThrow();
    expect(() => resolve({ secrets: { pin: 'long-enough' } }, { ...BASE_ENV, E2E_SECRET_PIN: '7' } as NodeJS.ProcessEnv)).toThrow(
      /secret "pin" must be at least 6 characters \(code points\), not 1/,
    );
    expect(() => resolve({ credentials: { admin: { username: 'u', password: 'short' } } })).toThrow(
      /credential "admin" password must be at least 6 characters \(code points\), not 5/,
    );
    expect(() =>
      resolve(
        { credentials: { admin: { username: 'u', password: 'long-enough' } } },
        { ...BASE_ENV, E2E_USER_ADMIN_PASSWORD: 'pw' } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/credential "admin" password must be at least 6 characters \(code points\), not 2/);
    expect(() => resolve({ secrets: { pin: () => '1' } })).not.toThrow();
  });

  it('counts a secret in code points, so three emoji are three characters and not six', () => {
    expect('🔐🔐🔐'.length).toBe(6);
    expect(() => resolve({ secrets: { pin: '🔐🔐🔐' } })).toThrow(/secret "pin" must be at least 6 characters \(code points\), not 3/);
    expect(() => resolve({ credentials: { admin: { username: 'u', password: '🔐🔐🔐' } } })).toThrow(
      /credential "admin" password must be at least 6 characters \(code points\), not 3/,
    );
    expect(() => resolve({ secrets: { pin: '🔐🔐🔐🔐🔐🔐' } })).not.toThrow();
  });


  it('replaces secret values in the config digest', () => {
    const a = resolve({ secrets: { key: 'secret-1' } });
    const b = resolve({ secrets: { key: 'secret-2' } });
    expect(a.configDigest).toBe(b.configDigest);
    const c = resolve({ secrets: { other: 'secret-1' } });
    expect(a.configDigest).not.toBe(c.configDigest);
  });

  it('replaces credential passwords in the config digest', () => {
    const a = resolve({ credentials: { member: { username: 'u', password: 'secret-1' } } });
    const b = resolve({ credentials: { member: { username: 'u', password: 'secret-2' } } });
    expect(a.configDigest).toBe(b.configDigest);
    const c = resolve({ credentials: { member: { username: 'other', password: 'secret-1' } } });
    expect(a.configDigest).not.toBe(c.configDigest);
  });

  it('digests the app a target declares, replacing command env values by name', () => {
    const declare = (app: TargetApp) => resolve({ targets: [declaredTarget(app)] });
    const a = declare({ url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'aaa' } } });
    const b = declare({ url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'bbb' } } });
    expect(a.configDigest).toBe(b.configDigest);
    expect(a.configDigest).not.toBe(declare({ url: 'http://localhost:3000', command: { executable: 'x', env: { OTHER: 'aaa' } } }).configDigest);
    expect(declare({ url: 'http://localhost:3000' }).configDigest).not.toBe(
      declare({ url: 'http://localhost:4000' }).configDigest,
    );
    expect(declare({ bundleId: 'a' }).configDigest).not.toBe(declare({ bundleId: 'b' }).configDigest);
    expect(declare({ bundleId: 'a', launchArguments: ['-x'] }).configDigest).not.toBe(declare({ bundleId: 'a' }).configDigest);
  });

  it('digests the platform an engine declares, which a named target inherits', () => {
    const driving = (platform: string) =>
      defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, platform, observe: async () => snapshot([]) });
    const digest = (platform: string) =>
      resolve({ targets: [{ name: 'app', engine: driving(platform) }] }).configDigest;
    expect(digest('web')).toBe(digest('web'));
    expect(digest('web')).not.toBe(digest('ios'));
  });

  describe('command.log', () => {
    const APP_URL = 'http://localhost:3000';

    it('accepts a relative or absolute path inside the project root', () => {
      expect(commandOf({ url: APP_URL, command: { executable: 'x', log: '.e2e/app.log' } }).command.log).toBe('.e2e/app.log');
      expect(commandOf({ url: APP_URL, command: { executable: 'x', log: `${ROOT}/.e2e/app.log` } }).command.log).toBe(`${ROOT}/.e2e/app.log`);
    });

    it('rejects an empty log path, naming the target', () => {
      expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', log: '' } })).toThrow(
        /target "web" app\.command\.log must be a non-empty path/,
      );
      expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', log: '  ' } })).toThrow(
        /app\.command\.log must be a non-empty path/,
      );
      expect(() =>
        resolveApp({ url: APP_URL, command: { executable: 'x', log: 7 as unknown as string } }),
      ).toThrow(/app\.command\.log must be a non-empty path/);
    });

    it('rejects a log path that leaves the project root or names the root itself', () => {
      expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', log: '../app.log' } })).toThrow(
        /app\.command\.log must be a file inside the project root/,
      );
      expect(() =>
        resolveApp({ url: APP_URL, command: { executable: 'x', log: '/tmp/elsewhere.log' } }),
      ).toThrow(/app\.command\.log must be a file inside the project root/);
      expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', log: '.' } })).toThrow(
        /app\.command\.log must be a file inside the project root/,
      );
    });

    it('accepts an entry whose name merely starts with two dots', () => {
      expect(commandOf({ url: APP_URL, command: { executable: 'x', log: '..logs/out.log' } }).command.log).toBe('..logs/out.log');
      expect(commandOf({ url: APP_URL, command: { executable: 'x', log: '..name' } }).command.log).toBe('..name');
    });

    it('checks containment through symlinks and accepts a symlinked project root', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-log-root-'));
      const resolveIn = (projectRoot: string, log: string) => commandOf({ url: APP_URL, command: { executable: 'x', log } }, projectRoot);
      try {
        const root = path.join(base, 'project');
        const outside = path.join(base, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, 'escape'));
        expect(() => resolveIn(root, 'escape/app.log')).toThrow(
          /app\.command\.log must be a file inside the project root/,
        );
        expect(() => resolveIn(root, 'escape/not/yet/created/app.log')).toThrow(
          /app\.command\.log must be a file inside the project root/,
        );
        fs.symlinkSync(path.join(outside, 'not-yet'), path.join(root, 'dangling'));
        expect(() => resolveIn(root, 'dangling/app.log')).toThrow(/app\.command\.log must be a file inside the project root/);
        expect(resolveIn(root, '.e2e/logs/app.log').command.log).toBe('.e2e/logs/app.log');
        const alias = path.join(base, 'alias');
        fs.symlinkSync(root, alias);
        expect(resolveIn(alias, '.e2e/logs/app.log').command.log).toBe('.e2e/logs/app.log');
        expect(resolveIn(alias, path.join(alias, 'app.log')).command.log).toBe(path.join(alias, 'app.log'));
        expect(() => resolveIn(alias, 'escape/app.log')).toThrow(
          /app\.command\.log must be a file inside the project root/,
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('enters the config digest like cwd does', () => {
      const declare = (log: string) =>
        resolve({ targets: [declaredTarget({ url: APP_URL, command: { executable: 'x', log } })] });
      expect(declare('a.log').configDigest).not.toBe(declare('b.log').configDigest);
      expect(declare('a.log').configDigest).toBe(declare('a.log').configDigest);
    });
  });

  it('rejects a declared readyUrl that is not an http(s) URL', () => {
    expect(() => resolveApp({ url: 'http://localhost:3000', readyUrl: 'not a url' })).toThrow(
      /app\.readyUrl must be an http\(s\) URL/,
    );
    expect(() => resolveApp({ url: 'http://localhost:3000', readyUrl: 'ftp://x/' })).toThrow(
      /app\.readyUrl must be an http\(s\) URL/,
    );
    expect(
      commandOf({
        url: 'http://localhost:3000',
        command: { executable: 'x' },
        readyUrl: 'http://localhost:3000/health',
      }).readiness,
    ).toEqual({ readyUrl: 'http://localhost:3000/health' });
  });

  describe('app.command', () => {
    const APP_URL = 'http://localhost:3000';

    it('accepts reuseExisting on a fixed port and checks its shape', () => {
      expect(commandOf({ url: APP_URL, command: { executable: 'pnpm', args: ['dev'], reuseExisting: true } }).command.reuseExisting).toBe(true);
      expect(() =>
        resolveApp({ url: APP_URL, command: { executable: 'x', reuseExisting: 'yes' as unknown as boolean } }),
      ).toThrow(/target "web" app\.command\.reuseExisting must be a boolean/);
    });

    it('rejects non-positive-integer timeouts', () => {
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];
      for (const value of bad) {
        expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', startupTimeout: value } })).toThrow(
          /app\.command\.startupTimeout must be a positive safe integer/,
        );
        expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', shutdownTimeout: value } })).toThrow(
          /app\.command\.shutdownTimeout must be a positive safe integer/,
        );
      }
      expect(commandOf({ url: APP_URL, command: { executable: 'x', startupTimeout: 5_000, shutdownTimeout: 500 } }).command).toMatchObject({ startupTimeout: 5_000, shutdownTimeout: 500 });
    });

  });

  describe('artifacts config', () => {
    /** The code and message of the error `resolve` throws for `raw`. */
    const failure = (raw: unknown): { code: string; message: string } => {
      try {
        resolve(raw as Partial<E2EConfig>);
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error('resolved');
    };

    it('holds only the store, and keeps it out of the digest', () => {
      expect(resolve({}).artifactStore).toBeUndefined();
      const store = { put: async () => ({ ref: 'x' }) };
      const withStore = resolve({ artifacts: { store } });
      expect(withStore.artifactStore).toBe(store);
      expect(withStore.configDigest).toBe(resolve({}).configDigest);
    });

    it('rejects unknown keys and a non-store store', () => {
      expect(() => resolve({ artifacts: { ttl: 1 } as never })).toThrow(/unknown artifacts config key "ttl"/);
      expect(() => resolve({ artifacts: { store: { upload: true } } as never })).toThrow(/artifacts.store must implement ArtifactStore/);
      expect(() => resolve({ artifacts: { store: { put: async () => ({ ref: '' }), putLink: 'yes' } } as never })).toThrow(
        'artifacts.store must implement ArtifactStore: { put(artifact), putLink?(link) }',
      );
      const linking = { put: async () => ({ ref: '' }), putLink: async () => ({ ref: '' }) };
      expect(resolve({ artifacts: { store: linking } }).artifactStore).toBe(linking);
      expect(() => resolve({ artifacts: 'on' as never })).toThrow(/artifacts must be \{ store \}/);
    });

    it('refuses the removed kinds list, in either form, naming what replaced it', () => {
      expect(failure({ artifacts: ['screenshot', 'trace'] })).toMatchObject({
        code: 'INVALID_CONFIG',
        message: `artifacts no longer lists kinds: ${TRACE_REMOVED}`,
      });
      expect(failure({ artifacts: { kinds: ['screenshot'] } }).message).toBe('artifacts.kinds was removed: delete it; artifacts is { store }');
      // A list without screenshot used to turn the failure screenshot off, which is no longer possible.
      expect(failure({ artifacts: [] }).message).toBe('artifacts no longer lists kinds: failure screenshots are always captured now');
      expect(failure({ artifacts: { kinds: ['trace'] } }).message).toBe(
        `artifacts.kinds was removed: ${TRACE_REMOVED}; failure screenshots are always captured now`,
      );
      expect(failure({ artifacts: { kinds: ['video'] } }).message).toContain("video is its own option: video: 'on'");
      expect(failure({ artifacts: { video: { retain: 'on-failure' } } as never }).message).toContain(
        'artifacts.video was removed: video is its own option',
      );
    });

    it('refuses the removed trace block, alone or beside a kinds list', () => {
      expect(failure({ artifacts: { trace: { record: 'retries' } } })).toMatchObject({
        code: 'INVALID_CONFIG',
        message: `artifacts.trace was removed: ${TRACE_REPLACEMENT}`,
      });
      for (const artifacts of [
        { kinds: ['screenshot', 'trace'], trace: { record: 'retries' } },
        { trace: { record: 'retries' }, kinds: ['screenshot', 'trace'] },
      ]) {
        expect(failure({ artifacts: artifacts as never }).message).toMatch(
          /^artifacts\.(kinds and artifacts\.trace|trace and artifacts\.kinds) were removed: --reporter markdown writes a page per failed test under <output>\/failures\//,
        );
      }
    });

    it('refuses trace at the config root and on a target, naming the failure pages and video', () => {
      for (const trace of ['on', 'off', 'retries', { record: 'all' }, true]) {
        expect(failure({ trace } as never)).toMatchObject({ code: 'INVALID_CONFIG', message: TRACE_REMOVED });
      }
      expect(failure({ targets: [{ ...WEB, trace: 'on' } as never] })).toMatchObject({
        code: 'INVALID_CONFIG',
        message: `target "web": ${TRACE_REMOVED}`,
      });
      expect(failure({ targets: [{ platform: 'web', trace: 'off' } as never] }).message).toBe(`targets[0]: ${TRACE_REMOVED}`);
      expect(failure({ video: 'all' as never }).message).toBe('video must be one of off, on, retain-on-failure, on-first-retry, on-all-retries, got "all"');
    });
  });

  describe('video', () => {
    const web = (mode: string) => ({ ...WEB, video: mode }) as unknown as Target;

    it('defaults, and a target inherits the config mode as a run-wide one', () => {
      expect(resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV }).targets[0]!.video).toEqual({ mode: 'off', source: 'default' });
      const inherited = resolveConfig({ targets: TARGETS, video: 'retain-on-failure' }, { projectRoot: ROOT, env: BASE_ENV });
      expect(inherited.targets[0]!.video).toEqual({ mode: 'retain-on-failure', source: 'run' });
    });

    it('lets a target override the config, and the flag override both', () => {
      const own = resolveConfig({ targets: [web('on-all-retries')], video: 'on' }, { projectRoot: ROOT, env: BASE_ENV });
      expect(own.targets[0]!.video).toEqual({ mode: 'on-all-retries', source: 'target' });
      const flagged = resolveConfig({ targets: [web('off')], video: 'off' }, { projectRoot: ROOT, env: BASE_ENV, cli: { video: 'on' } });
      expect(flagged.targets[0]!.video).toEqual({ mode: 'on', source: 'run' });
      const off = resolveConfig({ targets: TARGETS, video: 'on' }, { projectRoot: ROOT, env: BASE_ENV, cli: { video: 'off' } });
      expect(off.targets[0]!.video).toEqual({ mode: 'off', source: 'run' });
    });

    it('keeps the mode, at the top and on a target, out of the digest', () => {
      const plain = resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV }).configDigest;
      expect(resolveConfig({ targets: [web('on')], video: 'retain-on-failure' }, { projectRoot: ROOT, env: BASE_ENV }).configDigest).toBe(plain);
      expect(resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { video: 'on' } }).configDigest).toBe(plain);
    });

    it('refuses a mode it does not know, wherever it is set', () => {
      const modes = 'off, on, retain-on-failure, on-first-retry, on-all-retries';
      expect(() => resolveConfig({ targets: TARGETS, video: true } as never, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
        `video must be one of ${modes}, got true`,
      );
      expect(() => resolveConfig({ targets: [web('sometimes')] } as never, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
        `target "web" video must be one of ${modes}`,
      );
      // The flag wins over a target's mode, but never hides a mistake in it.
      expect(() => resolveConfig({ targets: [web('retain_on_failure')] } as never, { projectRoot: ROOT, env: BASE_ENV, cli: { video: 'on' } })).toThrow(
        `target "web" video must be one of`,
      );
      expect(() => resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { video: 'every' as never } })).toThrow(
        `--video must be one of`,
      );
    });
  });

  describe('output', () => {
    /** The message `resolve` throws for `raw` and `cli`. */
    const refusal = (raw: Partial<E2EConfig>, cli: { output?: string } = {}): string => {
      try {
        resolveConfig({ targets: TARGETS, ...raw }, { projectRoot: ROOT, env: BASE_ENV, cli });
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
        return (error as Error).message;
      }
      throw new Error('resolved');
    };

    it('defaults to .e2e, resolves from the project root, and --output wins over the config', () => {
      expect(resolve({}).output).toBe(path.join(ROOT, '.e2e'));
      expect(resolve({ output: 'results/e2e' }).output).toBe(path.join(ROOT, 'results', 'e2e'));
      expect(resolveConfig({ targets: TARGETS, output: 'results' }, { projectRoot: ROOT, env: BASE_ENV, cli: { output: 'out' } }).output).toBe(
        path.join(ROOT, 'out'),
      );
      // The default cache sits inside the default output, outside anything a run clears.
      expect(resolve({}).cache.dir).toBe(path.join(ROOT, '.e2e', 'cache'));
    });

    it('stays out of the digest', () => {
      expect(resolve({ output: 'results' }).configDigest).toBe(resolve({}).configDigest);
    });

    it('refuses a directory the run cannot own, with the reason', () => {
      expect(refusal({ output: '' })).toBe('output must be a non-empty path relative to the project root, got ""');
      expect(refusal({ output: 5 as never })).toContain('output must be a non-empty path');
      expect(refusal({ output: '.' })).toContain('output "." is the project root');
      expect(refusal({}, { output: './' })).toContain('--output "./" is the project root');
      expect(refusal({ output: '../elsewhere' })).toContain(`output "../elsewhere" is outside the project root ${ROOT}`);
      expect(refusal({ output: '/tmp/e2e-results' })).toContain('is outside the project root');
      expect(refusal({ output: '.e2e/cache' })).toContain('is the cache directory .e2e/cache or inside it');
      expect(refusal({ output: 'store/results', cache: { dir: 'store' } })).toContain('is the cache directory store or inside it');
      expect(refusal({ output: 'out', cache: { dir: 'out/artifacts/cache' } })).toContain('would hold cache.dir out/artifacts/cache under artifacts/');
      expect(refusal({ output: 'tests' })).toContain('holds tests, where the tests glob "tests/**/*.e2e.ts" finds test files');
      expect(refusal({ output: 'e2e', tests: ['e2e/smoke/**/*.e2e.ts'] })).toContain('holds e2e/smoke');
      expect(refusal({ output: 'e2e', tests: 'e2e/login.e2e.ts' })).toContain('holds e2e,');
    });

    it('names the default output when it is the one refused', () => {
      expect(refusal({ cache: { dir: '.e2e' } })).toBe(
        'output ".e2e" (the default) is the cache directory .e2e or inside it; keep results and the replay cache apart',
      );
      expect(refusal({ tests: '.e2e/**/*.e2e.ts' })).toContain('output ".e2e" (the default) holds .e2e,');
    });

    it('compares paths through symlinks, so one directory spelled two ways is one directory', () => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-output-')));
      const real = path.join(base, 'real');
      const link = path.join(base, 'link');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      try {
        // The project root as process.cwd() reports it, and a flag spelled through the link, as "$PWD/out" is.
        const flagged = resolveConfig({ targets: TARGETS }, { projectRoot: real, env: BASE_ENV, cli: { output: path.join(link, 'out') } });
        expect(flagged.output).toBe(path.join(link, 'out'));
        expect(resolveConfig({ targets: TARGETS }, { projectRoot: link, env: BASE_ENV, cli: { output: path.join(real, 'out') } }).output).toBe(
          path.join(real, 'out'),
        );
        // A cache the run would clear with <output>/artifacts, however it is spelled.
        expect(() =>
          resolveConfig({ targets: TARGETS, cache: { dir: path.join(link, '.e2e', 'artifacts', 'cache') } }, { projectRoot: real, env: BASE_ENV }),
        ).toThrow('output ".e2e" (the default) would hold cache.dir .e2e/artifacts/cache under artifacts/');
        expect(() =>
          resolveConfig({ targets: TARGETS }, { projectRoot: real, env: BASE_ENV, cli: { output: link } }),
        ).toThrow(`--output ${JSON.stringify(link)} is the project root`);
        // A link whose target does not exist yet is followed: the run's writes land where it points.
        fs.symlinkSync(path.join(base, 'elsewhere', 'results'), path.join(real, 'dangling'));
        for (const output of ['dangling', 'dangling/nested']) {
          expect(() => resolveConfig({ targets: TARGETS }, { projectRoot: real, env: BASE_ENV, cli: { output } })).toThrow(
            `--output ${JSON.stringify(output)} is outside the project root ${real}`,
          );
        }
        fs.symlinkSync('later', path.join(real, 'pending'));
        expect(resolveConfig({ targets: TARGETS }, { projectRoot: real, env: BASE_ENV, cli: { output: 'pending' } }).output).toBe(
          path.join(real, 'pending'),
        );
        fs.symlinkSync('.e2e/cache', path.join(real, 'into-cache'));
        expect(() => resolveConfig({ targets: TARGETS }, { projectRoot: real, env: BASE_ENV, cli: { output: 'into-cache' } })).toThrow(
          '--output "into-cache" is the cache directory .e2e/cache or inside it',
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses an output that is a file, or under one, at load', () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-output-')));
      fs.writeFileSync(path.join(root, 'results.txt'), 'not a directory');
      try {
        const at = (output: string) => () => resolveConfig({ targets: TARGETS }, { projectRoot: root, env: BASE_ENV, cli: { output } });
        expect(at('results.txt')).toThrow('--output "results.txt" is a file; name a directory, which the run creates when it is missing');
        expect(at('results.txt/e2e')).toThrow('--output "results.txt/e2e" is under the file results.txt;');
        expect(at('fresh/e2e')().output).toBe(path.join(root, 'fresh', 'e2e'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('accepts an output beside the tests, or inside a glob rooted higher up', () => {
      expect(resolve({ output: 'results', tests: ['tests/**/*.e2e.ts', '!results/**'] }).output).toBe(path.join(ROOT, 'results'));
      expect(resolve({ output: 'results', tests: '**/*.e2e.ts' }).output).toBe(path.join(ROOT, 'results'));
      expect(resolve({ output: 'out', cache: { dir: 'out/replays' } }).cache.dir).toBe(path.join(ROOT, 'out', 'replays'));
    });
  });
});

describe('discoverConfig', () => {
  /** A temp tree with the given files (a trailing slash makes a directory), removed after `body`. */
  function inTree(files: readonly string[], body: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-discover-'));
    try {
      for (const file of files) {
        const target = path.join(root, file);
        if (file.endsWith('/')) fs.mkdirSync(target, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, '');
        }
      }
      body(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('walks up from cwd to the nearest config and roots the project there', () => {
    inTree(['repo/.git/', 'repo/e2e.config.ts', 'repo/apps/web/e2e.config.mts', 'repo/apps/web/src/'], (root) => {
      expect(discoverConfig(path.join(root, 'repo/apps/web/src'))).toEqual({
        configPath: path.join(root, 'repo/apps/web/e2e.config.mts'),
        projectRoot: path.join(root, 'repo/apps/web'),
      });
      expect(discoverConfig(path.join(root, 'repo/apps'))).toEqual({
        configPath: path.join(root, 'repo/e2e.config.ts'),
        projectRoot: path.join(root, 'repo'),
      });
    });
  });

  it('stops at the repository root and never picks a config above it', () => {
    inTree(['e2e.config.ts', 'repo/.git', 'repo/a/b/'], (root) => {
      const cwd = path.join(root, 'repo/a/b');
      expect(discoverConfig(cwd)).toEqual({ configPath: undefined, projectRoot: cwd });
    });
  });

  it('refuses both spellings side by side, and an explicit path that does not exist', () => {
    inTree(['.git/', 'e2e.config.ts', 'e2e.config.mts', 'custom/my.config.ts'], (root) => {
      expect(() => discoverConfig(root)).toThrow(expect.objectContaining({ code: 'CONFIG_AMBIGUOUS' }));
      expect(discoverConfig(root, 'custom/my.config.ts')).toEqual({
        configPath: path.join(root, 'custom/my.config.ts'),
        projectRoot: path.join(root, 'custom'),
      });
      expect(() => discoverConfig(root, 'missing.config.ts')).toThrow(
        expect.objectContaining({ code: 'CONFIG_NOT_FOUND', message: 'config file not found: missing.config.ts' }),
      );
    });
  });
});
