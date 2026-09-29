import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCiMode, resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, type EngineAppDeclaration } from '../../src/engine/index.ts';
import { secrets } from '../../src/secrets.ts';
import type { E2EConfig, Target } from '../../src/types.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-config-project';
const BASE_ENV = {} as NodeJS.ProcessEnv;
const WEB = { name: 'web', platform: 'web' } as const;
const TARGETS = [WEB];

function resolve(raw: Partial<E2EConfig>, env: NodeJS.ProcessEnv = BASE_ENV) {
  return resolveConfig({ targets: TARGETS, ...raw }, { projectRoot: ROOT, env });
}

/** A minimal observing engine declaring the given app facts, the way web() or mobile() would. */
function fakeEngine(app: EngineAppDeclaration = {}) {
  return defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), app });
}

/** Resolves one web target whose engine declares `app`, and returns the resolved app. */
function resolveApp(app: EngineAppDeclaration = {}) {
  return resolve({ targets: [{ ...WEB, engine: fakeEngine(app) }] }).targets[0]!.app;
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
    expect(config.targets[0]!.trace).toEqual({ mode: 'on', source: 'default' });
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

  it('rejects a non-array targets value as INVALID_CONFIG', () => {
    expect(() => resolve({ targets: {} as never })).toThrow(/targets must be a non-empty array/);
  });

  it('uses CI defaults for retries and workers', () => {
    const config = resolve({}, { ...BASE_ENV, CI: '1' } as NodeJS.ProcessEnv);
    expect(config.retries).toBe(1);
    expect(config.workers).toBe(1);
  });

  it('requires explicit targets: core resolves no default engine', () => {
    // The type already demands targets; the loader still guards a config written in JavaScript.
    expect(() => resolveConfig({} as E2EConfig, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
      /targets is required/,
    );
    const config = resolve({});
    expect(config.targets[0]).toMatchObject({ name: 'web', platform: 'web', engine: undefined });
  });

  it('resolves the empty app for a target without an engine, or whose engine declares none', () => {
    expect(resolve({}).targets[0]!.app).toEqual({
      base: undefined,
      site: undefined,
      environment: 'test',
      identity: undefined,
      command: undefined,
      readyUrl: undefined,
      services: [],
    });
    expect(resolveApp().base).toBeUndefined();
  });

  it('resolves the URL an engine declares and rejects the retired top-level app key', () => {
    const app = resolveApp({ url: 'http://127.0.0.1:4000' });
    expect(app.base?.origin).toBe('http://127.0.0.1:4000');
    expect(app.base?.href).toBe('http://127.0.0.1:4000/');
    expect(() => resolve({ app: { url: 'http://127.0.0.1:4000' } } as never)).toThrow(/unknown config key "app"/);
    expect(() => resolve({ unknown: true } as never)).toThrow(/unknown config key/);
  });

  it('suggests the nearest key and points foreign keys at where the fact lives', () => {
    expect(() => resolve({ target: [] } as never)).toThrow('unknown config key "target"; did you mean "targets"?');
    expect(() => resolve({ reporter: ['list'] } as never)).toThrow('did you mean "reporters"?');
    expect(() => resolve({ testDir: 'tests' } as never)).toThrow(
      'unknown config key "testDir"; test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
    );
    expect(() => resolve({ app: {} } as never)).toThrow('the app under test is declared by the engine: engine: web({ url })');
    expect(() => resolve({ webServer: {} } as never)).toThrow('web({ url, command: { executable, args } })');
    expect(() => resolve({ screen: { testIdAttribute: 'data-qa' } } as never)).toThrow(
      'unknown config key "screen"; the test-id attribute is an engine option: engine: web({ testIdAttribute })',
    );
    expect(() => resolve({ targets: [{ ...WEB, url: 'http://localhost:3000' }] } as never)).toThrow(
      'target "web" has unknown key "url"; a target is { name?, platform?, engine?, trace?, video? }; the app under test is declared by the engine',
    );
    expect(() => resolve({ targets: [{ ...WEB, platfrom: 'web' }] } as never)).toThrow('did you mean "platform"?');
    expect(() => resolve({ reporters: ['lst'] } as never)).toThrow(
      'unknown reporter "lst"; reporters are list, json, junit, and markdown; did you mean "list"?',
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
    expect(() => fakeEngine({ command: { executable: 'node' } })).not.toThrow();
    expect(() => resolveApp({ command: { executable: 'node' } })).toThrow(/without a URL to poll/);
    expect(resolveApp({ url: 'http://localhost:3000', command: { executable: 'node' } })).toMatchObject({
      command: { executable: 'node' },
      readyUrl: 'http://localhost:3000/',
    });
    expect(resolveApp({ command: { executable: 'node' }, readyUrl: 'http://localhost:9/health' }).readyUrl).toBe(
      'http://localhost:9/health',
    );
    expect(() => resolveApp({ url: 'http://localhost:3000', command: { executable: '' } })).toThrow(
      /command.executable is required/,
    );
  });

  it('takes only strings in a command\'s args and env, naming secrets.get() for a handle', () => {
    const url = 'http://localhost:3000';
    expect(() => resolveApp({ url, command: { executable: 'node', args: ['server.mjs', 3000] } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" engine fake app.command.args[1] must be a string, got 3000' }),
    );
    expect(resolveApp({ url, command: { executable: 'node', env: { PORT: '3000', UNSET: undefined } } } as never).command?.env).toEqual({
      PORT: '3000',
    });
    expect(() => resolveApp({ url, command: { executable: 'node', env: ['PORT=3000'] } } as never)).toThrow(
      'target "web" engine fake app.command.env must be an object of variable name to string',
    );
    expect(() => resolveApp({ url, command: { executable: 'node', env: { PORT: 3000 } } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" engine fake app.command.env.PORT must be a string, got 3000' }),
    );
    expect(() => resolveApp({ url, command: { executable: 'node', env: { API_KEY: secrets.get('API_KEY') } } } as never)).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: expect.stringMatching(/^target "web" engine fake app\.command\.env\.API_KEY must be a string, got secrets\.get\("API_KEY"\): only an engine option that declares secrets/),
      }),
    );
    expect(() =>
      resolveApp({ url, services: [{ executable: 'db', waitForExit: true, env: { PASSWORD: secrets.get('db') } }] } as never),
    ).toThrow(/app\.services\[0\]\.env\.PASSWORD must be a string, got secrets\.get\("db"\)/);
  });

  it('rejects a command, service, or teardown key the contract does not know, naming the nearest', () => {
    const url = 'http://localhost:3000';
    expect(() => resolveApp({ url, command: { executable: 'node', arg: ['server.mjs'] } } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'target "web" engine fake app.command has unknown key "arg"; did you mean "args"?' }),
    );
    expect(() => resolveApp({ url, command: { executable: 'node', readyUrl: url } } as never)).toThrow(
      /app\.command has unknown key "readyUrl"; expected one of executable, args, cwd, env, startupTimeout, shutdownTimeout, log, reuseExisting/,
    );
    expect(() => resolveApp({ url, services: [{ executable: 'db', readyURL: url }] } as never)).toThrow(
      'target "web" engine fake app.services[0] has unknown key "readyURL"; did you mean "readyUrl"?',
    );
    expect(() =>
      resolveApp({ url, services: [{ executable: 'db', waitForExit: true, teardown: { executable: 'db', waitForExit: true } }] } as never),
    ).toThrow(/app\.services\[0\]\.teardown has unknown key "waitForExit"; expected one of executable, args/);
  });

  it('rejects specVersion, which the runner version replaced', () => {
    for (const specVersion of ['0.1', '0.2']) {
      expect(() => resolve({ specVersion } as never)).toThrow(
        'config key "specVersion" was removed; remove it; the runner version is the format version',
      );
    }
  });

  it('rejects target keys the contract does not know', () => {
    expect(() => resolve({ targets: [{ ...WEB, browser: 'firefox' }] } as never)).toThrow(
      /unknown key "browser"/,
    );
    expect(() => resolve({ targets: [{ ...WEB, driver: 'playwright' }] } as never)).toThrow(
      /unknown key "driver"/,
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
    expect(() => resolve({ targets: [{ engine: fakeEngine() }] })).toThrow(
      'targets[0] needs a platform: engine fake declares none; set platform on the target',
    );
  });

  it('accepts any platform: the engine decides what a target can do', () => {
    const engine = fakeEngine();
    const config = resolve({ targets: [{ name: 'ios', platform: 'ios', engine }] });
    expect(config.targets[0]).toMatchObject({ name: 'ios', platform: 'ios', engine });
    expect(config.targets[0]!.engine?.capabilities.has('observation')).toBe(true);
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
      /invalid app.environment/,
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
    expect(withProvider.secrets.get('admin')).toMatchObject({ purpose: 'password', value: provider });
    const overridden = resolve(
      {
        credentials: { admin: { username: 'admin', password: provider } },
      },
      { E2E_USER_ADMIN_PASSWORD: 'rotated' },
    );
    expect(overridden.secrets.get('admin')?.value).toBe('rotated');
    expect(() =>
      resolve({
        credentials: { admin: { username: 'admin', password: 42 as never } },
      }),
    ).toThrow(/password must be a non-empty string or a provider function/);
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

  it('keys identity on the declared identity, else the URL origin and path, else nothing', () => {
    expect(resolveApp({ url: 'https://app.test', identity: 'checkout-app' }).identity).toBe('checkout-app');
    expect(resolveApp({ url: 'https://app.test/shop/' }).identity).toBe('https://app.test/shop/');
    expect(resolveApp({ identity: 'com.example.app' }).identity).toBe('com.example.app');
    expect(resolveApp().identity).toBeUndefined();
    expect(() => resolveApp({ url: 'https://app.test', identity: '  ' })).toThrow(
      /app.identity must be a non-empty string/,
    );
  });

  it('rejects unknown app declaration keys at defineEngine', () => {
    expect(() => fakeEngine({ allowProduction: true } as never)).toThrow(/app has unknown key "allowProduction"/);
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

  it('validates numeric bounds', () => {
    expect(() => resolve({ retries: 11 })).toThrow(/retries/);
    expect(() => resolve({ retries: -1 })).toThrow(/retries/);
    expect(() => resolve({ timeout: 0 })).toThrow(/timeout/);
    expect(() => resolve({ workers: 0 })).toThrow(/workers/);
  });

  it('checks every secret an engine option holds against the configured secrets and credentials', () => {
    const engine = (name: string) =>
      defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), secrets: [secrets.get(name)] });
    const declared = { secrets: { stagingPassword: 'staging-pass' }, credentials: { admin: { username: 'admin', password: 'admin-pass' } } };
    expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine('stagingPassword') }] })).not.toThrow();
    expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine('admin') }] })).not.toThrow();
    expect(() => resolve({ ...declared, targets: [{ ...WEB, engine: engine('stagingPasword') }] })).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message:
          'target "web" engine fake uses secrets.get("stagingPasword"), which is not configured; add it to config.secrets or config.credentials; did you mean "stagingPassword"?',
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
    expect(config.secrets.get('member')?.value).toBe('env-pass');
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

  it('rejects an empty or non-string secret and a secret sharing a credential name', () => {
    expect(() => resolve({ secrets: { key: '' } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: 42 as never } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: { value: 'v' } as never } })).toThrow(/secret "key" must be a non-empty string/);
    expect(() => resolve({ secrets: { key: 'v' } }, { ...BASE_ENV, E2E_SECRET_KEY: '' } as NodeJS.ProcessEnv)).toThrow(/secret "key" must be/);
    expect(() =>
      resolve({ credentials: { admin: { username: 'u', password: 'password-1' } }, secrets: { admin: 'value-1' } }),
    ).toThrow(/secret "admin" is also a credential/);
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

  it('digests the app an engine declares, replacing command env values by name', () => {
    const declare = (app: EngineAppDeclaration) => resolve({ targets: [{ ...WEB, engine: fakeEngine(app) }] });
    const a = declare({ url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'aaa' } } });
    const b = declare({ url: 'http://localhost:3000', command: { executable: 'x', env: { TOKEN: 'bbb' } } });
    expect(a.configDigest).toBe(b.configDigest);
    expect(declare({ url: 'http://localhost:3000' }).configDigest).not.toBe(
      declare({ url: 'http://localhost:4000' }).configDigest,
    );
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

    it('accepts a relative or absolute path inside the project root on commands, services, and teardowns', () => {
      const app = resolveApp({
        url: APP_URL,
        command: { executable: 'x', log: '.e2e/app.log' },
        services: [
          {
            executable: 'y',
            waitForExit: true,
            log: `${ROOT}/.e2e/services.log`,
            teardown: { executable: 'z', log: 'teardown.log' },
          },
        ],
      });
      expect(app.command?.log).toBe('.e2e/app.log');
      expect(app.services[0]?.command.log).toBe(`${ROOT}/.e2e/services.log`);
      expect(app.services[0]?.teardown?.command.log).toBe('teardown.log');
    });

    it('rejects an empty log path, naming the target', () => {
      expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', log: '' } })).toThrow(
        /target "web" engine fake app\.command\.log must be a non-empty path/,
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
      expect(() =>
        resolveApp({
          url: APP_URL,
          services: [{ executable: 'x', waitForExit: true, teardown: { executable: 'y', log: '../t.log' } }],
        }),
      ).toThrow(/app\.services\[0\]\.teardown\.log must be a file inside the project root/);
    });

    it('accepts an entry whose name merely starts with two dots', () => {
      expect(resolveApp({ url: APP_URL, command: { executable: 'x', log: '..logs/out.log' } }).command?.log).toBe(
        '..logs/out.log',
      );
      expect(resolveApp({ url: APP_URL, command: { executable: 'x', log: '..name' } }).command?.log).toBe('..name');
    });

    it('checks containment through symlinks and accepts a symlinked project root', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-log-root-'));
      const resolveIn = (projectRoot: string, log: string) =>
        resolveConfig(
          { targets: [{ ...WEB, engine: fakeEngine({ url: APP_URL, command: { executable: 'x', log } }) }] },
          { projectRoot, env: BASE_ENV },
        ).targets[0]!.app;
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
        expect(resolveIn(root, '.e2e/logs/app.log').command?.log).toBe('.e2e/logs/app.log');
        const alias = path.join(base, 'alias');
        fs.symlinkSync(root, alias);
        expect(resolveIn(alias, '.e2e/logs/app.log').command?.log).toBe('.e2e/logs/app.log');
        expect(resolveIn(alias, path.join(alias, 'app.log')).command?.log).toBe(path.join(alias, 'app.log'));
        expect(() => resolveIn(alias, 'escape/app.log')).toThrow(
          /app\.command\.log must be a file inside the project root/,
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('enters the config digest like cwd does', () => {
      const declare = (log: string) =>
        resolve({ targets: [{ ...WEB, engine: fakeEngine({ url: APP_URL, command: { executable: 'x', log } }) }] });
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
      resolveApp({
        url: 'http://localhost:3000',
        command: { executable: 'x' },
        readyUrl: 'http://localhost:3000/health',
      }).readyUrl,
    ).toBe('http://localhost:3000/health');
  });

  describe('declared services', () => {
    const APP_URL = 'http://localhost:3000';

    it('accepts services with exactly one readiness contract and defaults to none', () => {
      expect(resolveApp().services).toEqual([]);
      expect(resolve({}).targets[0]!.app.services).toEqual([]);
      const app = resolveApp({
        url: APP_URL,
        services: [
          { executable: 'docker', args: ['compose', 'up', '--wait'], waitForExit: true },
          { executable: 'node', args: ['emulator.js'], readyUrl: 'http://127.0.0.1:7000/health' },
        ],
      });
      expect(app.services).toHaveLength(2);
      expect(app.services[0]?.readiness).toEqual({ waitForExit: true });
      // Without a name the label is the executable's base name.
      expect(app.services[0]?.label).toBe('service "docker"');
      expect(app.services[1]?.readiness).toEqual({ readyUrl: 'http://127.0.0.1:7000/health' });
      // Runner-only fields are lifted out of the command that gets spawned.
      expect(app.services[1]?.command).toEqual({ executable: 'node', args: ['emulator.js'] });
    });

    it('labels a service by its name and lifts the name out of the command', () => {
      const app = resolveApp({
        url: APP_URL,
        services: [
          {
            name: 'postgres',
            executable: 'sh',
            args: ['-c', 'exec docker compose up --wait postgres >> /var/log/postgres.log 2>&1'],
            waitForExit: true,
            teardown: { executable: 'sh', args: ['-c', 'docker compose down'] },
          },
          { name: '  auth-emulator  ', executable: '/usr/local/bin/emulator', waitForExit: true },
          { executable: '/usr/local/bin/emulator', waitForExit: true },
        ],
      });
      expect(app.services[0]?.label).toBe('service "postgres"');
      expect(app.services[0]?.teardown?.label).toBe('service "postgres" teardown');
      expect(app.services[0]?.command).not.toHaveProperty('name');
      expect(app.services[1]?.label).toBe('service "auth-emulator"');
      expect(app.services[2]?.label).toBe('service "emulator"');
    });

    it('rejects empty, oversized, and non-string service names', () => {
      for (const name of ['', '   ', 'x'.repeat(65), 42 as unknown as string]) {
        expect(() => resolveApp({ url: APP_URL, services: [{ name, executable: 'x', waitForExit: true }] })).toThrow(
          /app\.services\[0\]\.name must be a non-empty string of at most 64 characters/,
        );
      }
      const longest = 'x'.repeat(64);
      expect(
        resolveApp({ url: APP_URL, services: [{ name: longest, executable: 'x', waitForExit: true }] }).services[0]
          ?.label,
      ).toBe(`service "${longest}"`);
    });

    it('rejects duplicate service names but lets derived names repeat', () => {
      expect(() =>
        resolveApp({
          url: APP_URL,
          services: [
            { name: 'db', executable: 'x', waitForExit: true },
            { name: ' db ', executable: 'y', waitForExit: true },
          ],
        }),
      ).toThrow(/app\.services\[1\]\.name "db" is already used by another service/);
      const app = resolveApp({
        url: APP_URL,
        services: [
          { executable: 'pnpm', args: ['db:migrate'], waitForExit: true },
          { executable: 'pnpm', args: ['db:seed'], waitForExit: true },
        ],
      });
      expect(app.services.map((service) => service.label)).toEqual(['service "pnpm"', 'service "pnpm"']);
    });

    it('allows services without a URL or a command', () => {
      const app = resolveApp({ services: [{ executable: 'pnpm', args: ['db:migrate'], waitForExit: true }] });
      expect(app.base).toBeUndefined();
      expect(app.command).toBeUndefined();
      expect(app.services).toHaveLength(1);
    });

    it('rejects a service with neither or both readiness contracts', () => {
      expect(() => resolveApp({ url: APP_URL, services: [{ executable: 'x' }] })).toThrow(
        /app\.services\[0\] needs exactly one readiness contract/,
      );
      expect(() =>
        resolveApp({
          url: APP_URL,
          services: [{ executable: 'x', readyUrl: 'http://127.0.0.1:1/', waitForExit: true }],
        }),
      ).toThrow(/app\.services\[0\] needs exactly one readiness contract/);
    });

    it('accepts reuseExisting on a readyUrl service and rejects it where nothing can be reused', () => {
      const app = resolveApp({
        url: APP_URL,
        command: { executable: 'pnpm', args: ['dev'], reuseExisting: true },
        services: [{ executable: 'node', args: ['emulator.js'], readyUrl: 'http://127.0.0.1:7000/', reuseExisting: true }],
      });
      expect(app.command?.reuseExisting).toBe(true);
      expect(app.services[0]?.command.reuseExisting).toBe(true);
      expect(() =>
        resolveApp({ url: APP_URL, services: [{ executable: 'x', waitForExit: true, reuseExisting: true }] }),
      ).toThrow(/app\.services\[0\]\.reuseExisting needs readyUrl: a waitForExit service has nothing to reuse/);
      expect(() =>
        resolveApp({
          url: APP_URL,
          services: [
            { executable: 'x', readyUrl: 'http://127.0.0.1:1/', teardown: { executable: 'y', reuseExisting: true } },
          ],
        }),
      ).toThrow(/app\.services\[0\]\.teardown\.reuseExisting needs readyUrl/);
      expect(() =>
        resolveApp({ url: APP_URL, command: { executable: 'x', reuseExisting: 'yes' as unknown as boolean } }),
      ).toThrow(/target "web" engine fake app\.command\.reuseExisting must be a boolean/);
    });

    it('rejects malformed services, naming the target', () => {
      expect(() => resolveApp({ url: APP_URL, services: { executable: 'x' } as unknown as [] })).toThrow(
        /target "web" engine fake app\.services must be an array/,
      );
      expect(() => resolveApp({ url: APP_URL, services: [{ executable: '', waitForExit: true }] })).toThrow(
        /app\.services\[0\]\.executable is required/,
      );
      expect(() => resolveApp({ url: APP_URL, services: [{ executable: 'x', readyUrl: 'not a url' }] })).toThrow(
        /app\.services\[0\]\.readyUrl must be an http\(s\) URL/,
      );
      expect(() =>
        resolveApp({
          url: APP_URL,
          services: [{ executable: 'x', waitForExit: true, teardown: { executable: '' } }],
        }),
      ).toThrow(/app\.services\[0\]\.teardown\.executable is required/);
    });

    it('rejects non-positive-integer timeouts on the command, services, and teardowns', () => {
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];
      for (const value of bad) {
        expect(() => resolveApp({ url: APP_URL, command: { executable: 'x', startupTimeout: value } })).toThrow(
          /app\.command\.startupTimeout must be a positive safe integer/,
        );
        expect(() =>
          resolveApp({ url: APP_URL, services: [{ executable: 'x', waitForExit: true, startupTimeout: value }] }),
        ).toThrow(/app\.services\[0\]\.startupTimeout must be a positive safe integer/);
        expect(() =>
          resolveApp({ url: APP_URL, services: [{ executable: 'x', waitForExit: true, shutdownTimeout: value }] }),
        ).toThrow(/app\.services\[0\]\.shutdownTimeout must be a positive safe integer/);
        expect(() =>
          resolveApp({
            url: APP_URL,
            services: [{ executable: 'x', waitForExit: true, teardown: { executable: 'y', startupTimeout: value } }],
          }),
        ).toThrow(/app\.services\[0\]\.teardown\.startupTimeout must be a positive safe integer/);
        expect(() =>
          resolveApp({
            url: APP_URL,
            services: [{ executable: 'x', waitForExit: true, teardown: { executable: 'y', shutdownTimeout: value } }],
          }),
        ).toThrow(/app\.services\[0\]\.teardown\.shutdownTimeout must be a positive safe integer/);
      }
      const ok = resolveApp({
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
      });
      expect(ok.services[0]?.teardown?.command.startupTimeout).toBe(5_000);
      expect(ok.services[0]?.teardown?.label).toBe('service "x" teardown');
    });

    it('replaces service and teardown env values in the config digest', () => {
      const declare = (app: EngineAppDeclaration) => resolve({ targets: [{ ...WEB, engine: fakeEngine(app) }] });
      const services = (secret: string) => [
        {
          executable: 'docker',
          args: ['compose', 'up', '--wait'],
          waitForExit: true,
          env: { POSTGRES_PASSWORD: secret },
          teardown: { executable: 'docker', args: ['compose', 'down'], env: { POSTGRES_PASSWORD: secret } },
        },
      ];
      const a = declare({ url: APP_URL, services: services('aaa') });
      const b = declare({ url: APP_URL, services: services('bbb') });
      expect(a.configDigest).toBe(b.configDigest);
      const renamed = declare({ url: APP_URL, services: [{ ...services('aaa')[0]!, env: { PGPASSWORD: 'aaa' } }] });
      expect(renamed.configDigest).not.toBe(a.configDigest);
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

    it('refuses the removed kinds list, in either form, naming the trace mode it meant', () => {
      expect(failure({ artifacts: ['screenshot', 'trace'] })).toMatchObject({
        code: 'INVALID_CONFIG',
        message: expect.stringContaining("artifacts no longer lists kinds; write trace: 'on' at the config root instead"),
      });
      const screenshotOnly = failure({ artifacts: { kinds: ['screenshot'] } });
      expect(screenshotOnly.message).toMatch(/^artifacts.kinds was removed; write trace: 'off'/);
      expect(screenshotOnly.message).not.toContain('failure screenshots');
      // A list without screenshot used to turn the failure screenshot off, which is no longer possible.
      expect(failure({ artifacts: [] }).message).toContain('failure screenshots are always captured now');
      expect(failure({ artifacts: { kinds: ['trace'] } }).message).toContain('failure screenshots are always captured now');
    });

    it('refuses the removed trace block, naming the mode its record meant', () => {
      expect(failure({ artifacts: { trace: { record: 'retries' } } })).toMatchObject({
        code: 'INVALID_CONFIG',
        message: expect.stringContaining("artifacts.trace was removed; write trace: 'on-all-retries' at the config root"),
      });
      expect(failure({ artifacts: { trace: {} } }).message).toContain("write trace: 'on'");
    });

    it('refuses video as an artifact kind or an artifacts block, naming the video option', () => {
      for (const artifacts of [['screenshot', 'video'], { kinds: ['video'] }, { video: { retain: 'on-failure' } }]) {
        expect(failure({ artifacts })).toMatchObject({
          code: 'INVALID_CONFIG',
          message: expect.stringContaining("video is its own option: video: 'on'"),
        });
      }
    });
  });

  describe.each(['trace', 'video'] as const)('%s', (kind) => {
    const web = (mode: string) => ({ ...WEB, [kind]: mode }) as unknown as Target;
    const fallback = kind === 'trace' ? 'on' : 'off';

    it('defaults, and a target inherits the config mode as a run-wide one', () => {
      expect(resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV }).targets[0]![kind]).toEqual({ mode: fallback, source: 'default' });
      const inherited = resolveConfig({ targets: TARGETS, [kind]: 'retain-on-failure' }, { projectRoot: ROOT, env: BASE_ENV });
      expect(inherited.targets[0]![kind]).toEqual({ mode: 'retain-on-failure', source: 'run' });
    });

    it('lets a target override the config, and the flag override both', () => {
      const own = resolveConfig({ targets: [web('on-all-retries')], [kind]: 'on' }, { projectRoot: ROOT, env: BASE_ENV });
      expect(own.targets[0]![kind]).toEqual({ mode: 'on-all-retries', source: 'target' });
      const flagged = resolveConfig({ targets: [web('off')], [kind]: 'off' }, { projectRoot: ROOT, env: BASE_ENV, cli: { [kind]: 'on' } });
      expect(flagged.targets[0]![kind]).toEqual({ mode: 'on', source: 'run' });
    });

    it('keeps the mode, at the top and on a target, out of the digest', () => {
      const plain = resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV }).configDigest;
      expect(resolveConfig({ targets: [web('on')], [kind]: 'retain-on-failure' }, { projectRoot: ROOT, env: BASE_ENV }).configDigest).toBe(plain);
      expect(resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { [kind]: 'on' } }).configDigest).toBe(plain);
    });

    it('refuses a mode it does not know, wherever it is set', () => {
      const modes = 'off, on, retain-on-failure, on-first-retry, on-all-retries';
      expect(() => resolveConfig({ targets: TARGETS, [kind]: true } as never, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
        `${kind} must be one of ${modes}, got true`,
      );
      expect(() => resolveConfig({ targets: [web('sometimes')] } as never, { projectRoot: ROOT, env: BASE_ENV })).toThrow(
        `target "web" ${kind} must be one of ${modes}`,
      );
      // The flag wins over a target's mode, but never hides a mistake in it.
      expect(() => resolveConfig({ targets: [web('retain_on_failure')] } as never, { projectRoot: ROOT, env: BASE_ENV, cli: { [kind]: 'on' } })).toThrow(
        `target "web" ${kind} must be one of`,
      );
      expect(() => resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: BASE_ENV, cli: { [kind]: 'all' as never } })).toThrow(
        `--${kind} must be one of`,
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

    it('accepts an output beside the tests, or inside a glob rooted higher up', () => {
      expect(resolve({ output: 'results', tests: ['tests/**/*.e2e.ts', '!results/**'] }).output).toBe(path.join(ROOT, 'results'));
      expect(resolve({ output: 'results', tests: '**/*.e2e.ts' }).output).toBe(path.join(ROOT, 'results'));
      expect(resolve({ output: 'out', cache: { dir: 'out/replays' } }).cache.dir).toBe(path.join(ROOT, 'out', 'replays'));
    });
  });

  it('traces the first retry by default in CI, where retries default to 1', () => {
    const ci = resolveConfig({ targets: TARGETS }, { projectRoot: ROOT, env: { CI: 'true' } as NodeJS.ProcessEnv });
    expect(ci.targets[0]!.trace).toEqual({ mode: 'on-first-retry', source: 'default' });
    expect(ci.retries).toBe(1);
    expect(ci.targets[0]!.video).toEqual({ mode: 'off', source: 'default' });
  });
});
