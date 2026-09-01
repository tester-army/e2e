/** Config validation, defaults, and resolution (spec 05-config.md). */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import { isImplicitTestHost, normalizeBaseUrl, type NormalizedBaseUrl } from '../internal/urls.ts';
import { isDriverHandle, type Driver } from '../driver/index.ts';
import {
  DEFAULT_DRIVER_ID,
  isWellKnownDriverId,
  wellKnownDriverIds,
  type WellKnownDriverId,
} from './drivers.ts';
import { isStepExecutor } from '../agent/executor.ts';
import type {
  AgentConfig,
  CacheMode,
  CommandConfig,
  E2EConfig,
  Target,
  TraceCacheStore,
  WebTarget,
} from '../types.ts';
import {
  isModelInstance,
  resolveAgentConfig,
  resolveLimits,
  type ResolvedAgentConfig,
  type ResolvedLimits,
} from './agent.ts';

export type { ResolvedAgentConfig, ResolvedLimits, ResolvedModel } from './agent.ts';

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: 'web';
  readonly browser: 'chromium' | 'firefox' | 'webkit';
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
  /** Well-known driver id resolved on demand, or an imported branded handle. */
  readonly driver: WellKnownDriverId | Driver;
  /** Wire-shaped target passed to the driver at launch. */
  readonly driverTarget: Target;
}

export interface ResolvedCredential {
  readonly name: string;
  readonly username: string;
  readonly password: string;
  readonly allowedOrigins: readonly string[] | undefined;
}

export interface ResolvedConfig {
  readonly specVersion: '0.1';
  readonly projectId: string;
  readonly projectRoot: string;
  readonly configPath: string | undefined;
  readonly ci: boolean;
  readonly app: {
    readonly base: NormalizedBaseUrl;
    readonly readyUrl: string;
    readonly allowedOrigins: readonly string[];
    readonly environment: 'test' | 'staging' | 'production';
    readonly allowProduction: boolean;
    readonly command: CommandConfig | undefined;
    /** Stable logical app identity; overrides the origin for cache/session keying. */
    readonly identity: string | undefined;
  };
  readonly targets: readonly ResolvedTarget[];
  readonly tests: readonly string[];
  readonly timeout: number;
  readonly launchTimeout: number;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
  readonly cleanupTimeout: number;
  readonly retries: number;
  readonly workers: number;
  readonly artifacts: readonly ('trace' | 'screenshot' | 'video')[];
  readonly reporters: readonly ('list' | 'json')[];
  readonly testIdAttribute: string;
  readonly agent: ResolvedAgentConfig;
  readonly cache: ResolvedCacheConfig;
  readonly limits: ResolvedLimits;
  readonly credentials: ReadonlyMap<string, ResolvedCredential>;
  readonly configDigest: string;
}

/**
 * The resolved trace cache posture. Like executors and model instances, a
 * custom store never crosses a process boundary: workers re-resolve the
 * config module and construct their own.
 */
export interface ResolvedCacheConfig {
  readonly mode: CacheMode;
  /** Custom entry store; undefined selects the file store at `dir`. */
  readonly store: TraceCacheStore | undefined;
  /** Absolute file store directory. */
  readonly dir: string;
}

export interface CliOverrides {
  retries?: number;
  workers?: number;
  reporters?: readonly ('list' | 'json')[];
  headed?: boolean;
  artifactsDir?: string;
  /** Trace cache mode override; `--no-cache` maps to `'off'`. */
  cache?: CacheMode;
}

const TARGET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const TOP_LEVEL_KEYS = new Set([
  'specVersion',
  'projectId',
  'app',
  'targets',
  'browser',
  'tests',
  'timeout',
  'launchTimeout',
  'actionTimeout',
  'assertionTimeout',
  'cleanupTimeout',
  'retries',
  'workers',
  'artifacts',
  'reporters',
  'screen',
  'agent',
  'cache',
  'limits',
  'credentials',
]);

const CACHE_KEYS = new Set(['mode', 'store', 'dir']);
const CACHE_MODES = new Set(['off', 'read-only', 'read-write']);

const APP_KEYS = new Set([
  'url',
  'command',
  'readyUrl',
  'allowedOrigins',
  'environment',
  'allowProduction',
  'identity',
]);

/** True when CI mode is active per 05-config.md. */
export function isCiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CI'];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/** Resolves a raw config object plus environment into an immutable resolved config. */
export function resolveConfig(
  raw: E2EConfig,
  options: {
    projectRoot: string;
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    cli?: CliOverrides;
  },
): ResolvedConfig {
  const env = options.env ?? process.env;
  const cli = options.cli ?? {};
  const ci = isCiMode(env);

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', 'config must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown config key "${key}"`);
    }
  }
  if (raw.specVersion !== undefined && raw.specVersion !== '0.1') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `unsupported specVersion ${JSON.stringify(raw.specVersion)}; this runner implements 0.1`,
    );
  }

  const app = resolveApp(raw, env);
  const targets = resolveTargets(raw);
  const tests = normalizeTests(raw.tests);

  const timeout = positiveInt(raw.timeout, 'timeout') ?? 120_000;
  const launchTimeout = positiveInt(raw.launchTimeout, 'launchTimeout') ?? 60_000;
  const actionTimeout = positiveInt(raw.actionTimeout, 'actionTimeout') ?? 30_000;
  const assertionTimeout = positiveInt(raw.assertionTimeout, 'assertionTimeout') ?? 5_000;
  const cleanupTimeout = positiveInt(raw.cleanupTimeout, 'cleanupTimeout') ?? 30_000;

  const retries = cli.retries ?? boundedInt(raw.retries, 'retries', 0, 10) ?? (ci ? 1 : 0);
  const workers =
    cli.workers ??
    boundedInt(raw.workers, 'workers', 1, 1024) ??
    (ci ? 1 : Math.max(1, Math.floor(os.availableParallelism() / 2)));

  const artifacts = raw.artifacts ?? (['screenshot', 'trace'] as const);
  for (const artifact of artifacts) {
    if (!['screenshot', 'trace', 'video'].includes(artifact)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown artifact kind "${artifact}"`);
    }
  }
  const reporters = cli.reporters ?? raw.reporters ?? (['list'] as const);
  for (const reporter of reporters) {
    if (!['list', 'json'].includes(reporter)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown reporter "${reporter}"`);
    }
  }
  if (reporters.includes('json') && reporters.includes('list')) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'the json renderer cannot be combined with list',
    );
  }

  const testIdAttribute = raw.screen?.testIdAttribute ?? 'data-testid';
  const projectId = resolveProjectId(raw.projectId, options.projectRoot);
  const credentials = resolveCredentials(raw, env);
  // Limits first: the agent context budget is a limits key, and the resolved
  // observation budget is agent-owned, so the dependency runs one way.
  const baseLimits = resolveLimits(raw);
  const agent = resolveAgentConfig(raw, env, ci, baseLimits);
  const limits: ResolvedLimits = { ...baseLimits, maxObservationBytes: agent.maxObservationBytes };
  const cache = resolveCacheConfig(raw, ci, options.projectRoot, cli.cache);

  const resolved: ResolvedConfig = {
    specVersion: '0.1',
    projectId,
    projectRoot: options.projectRoot,
    configPath: options.configPath,
    ci,
    app,
    targets,
    tests,
    timeout,
    launchTimeout,
    actionTimeout,
    assertionTimeout,
    cleanupTimeout,
    retries,
    workers,
    artifacts,
    reporters,
    testIdAttribute,
    agent,
    cache,
    limits,
    credentials,
    configDigest: computeConfigDigest(raw, projectId),
  };
  return resolved;
}

/**
 * Resolves the `cache` key. The cache is opt-out: an unset key means
 * `read-write`, so a project earns replay speed without asking for it, and
 * `cache: 'off'` or `--no-cache` (which wins over the config) turns it off.
 * CI forces the default file store from `read-write` down to `read-only`:
 * committed caches are untrusted input, and a CI run never publishes what it
 * learned (spec 10-determinism.md). A host-supplied `cache.store` is exempt —
 * it is not a committed file cache, and the host states its own trust through
 * the store's `writable` flag.
 */
function resolveCacheConfig(
  raw: E2EConfig,
  ci: boolean,
  projectRoot: string,
  cliMode: CacheMode | undefined,
): ResolvedCacheConfig {
  const value = raw.cache;
  let mode: CacheMode = 'read-write';
  let store: TraceCacheStore | undefined;
  let dir: string | undefined;
  if (typeof value === 'string') {
    mode = value;
  } else if (value !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        "cache must be 'off', 'read-only', 'read-write', or an options object",
      );
    }
    for (const key of Object.keys(value)) {
      if (!CACHE_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown cache config key "${key}"`);
      }
    }
    mode = value.mode ?? 'read-write';
    store = value.store;
    if (store !== undefined && !isTraceCacheStore(store)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'cache.store must implement TraceCacheStore: { writable, read(keyHash), write(keyHash, payload) }',
      );
    }
    if (value.dir !== undefined) {
      if (typeof value.dir !== 'string' || value.dir.trim() === '') {
        throw new ConfigurationError('INVALID_CONFIG', 'cache.dir must be a non-empty path');
      }
      dir = value.dir;
    }
  }
  if (!CACHE_MODES.has(mode)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `cache mode must be 'off', 'read-only', or 'read-write', got ${JSON.stringify(mode)}`,
    );
  }
  if (cliMode !== undefined) mode = cliMode;
  if (ci && mode === 'read-write' && store === undefined) mode = 'read-only';
  return {
    mode,
    store,
    dir: path.resolve(projectRoot, dir ?? path.join('.e2e', 'cache')),
  };
}

/** Structural store check, mirroring how executors and models are detected. */
function isTraceCacheStore(value: unknown): value is TraceCacheStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['writable'] === 'boolean' &&
    typeof candidate['read'] === 'function' &&
    typeof candidate['write'] === 'function'
  );
}

function positiveInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a positive safe integer`);
  }
  return value;
}

function boundedInt(
  value: number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an integer from ${min} through ${max}`,
    );
  }
  return value;
}

function resolveApp(raw: E2EConfig, env: NodeJS.ProcessEnv): ResolvedConfig['app'] {
  if (raw.app !== undefined) {
    for (const key of Object.keys(raw.app)) {
      if (!APP_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown app config key "${key}"`);
      }
    }
  }
  const rawUrl = raw.app?.url ?? env['APP_URL'];
  if (rawUrl === undefined || rawUrl === '') {
    throw new ConfigurationError(
      'APP_URL_REQUIRED',
      'an app URL is required: set app.url in e2e.config.ts or the APP_URL environment variable',
    );
  }
  const base = normalizeBaseUrl(rawUrl);
  const baseHost = new URL(base.href).hostname;

  let environment = raw.app?.environment;
  if (environment === undefined) {
    if (!isImplicitTestHost(baseHost)) {
      throw new ConfigurationError(
        'ENVIRONMENT_REQUIRED',
        `host ${baseHost} requires an explicit app.environment of "test", "staging", or "production"`,
      );
    }
    environment = 'test';
  }
  if (!['test', 'staging', 'production'].includes(environment)) {
    throw new ConfigurationError('INVALID_CONFIG', `invalid app.environment "${environment}"`);
  }
  const allowProduction = raw.app?.allowProduction ?? false;
  if (environment === 'production' && !allowProduction) {
    throw new ConfigurationError(
      'PRODUCTION_NOT_ALLOWED',
      'a production target is rejected unless allowProduction: true',
    );
  }

  const allowedOrigins = raw.app?.allowedOrigins ?? [base.origin];
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigurationError('INVALID_CONFIG', `invalid allowed origin: ${origin}`);
    }
    if (parsed.origin !== origin) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `allowed origin must be a serialized origin, got ${origin} (expected ${parsed.origin})`,
      );
    }
  }

  const command = raw.app?.command;
  if (command !== undefined) {
    if (typeof command.executable !== 'string' || command.executable.length === 0) {
      throw new ConfigurationError('INVALID_CONFIG', 'app.command.executable is required');
    }
  }

  const identity = raw.app?.identity;
  if (identity !== undefined && (typeof identity !== 'string' || identity.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'app.identity must be a non-empty string');
  }

  return {
    base,
    readyUrl: raw.app?.readyUrl ?? base.href,
    allowedOrigins,
    environment,
    allowProduction,
    command,
    identity,
  };
}

function resolveTargets(raw: E2EConfig): readonly ResolvedTarget[] {
  if (raw.targets !== undefined && raw.browser !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'defining both top-level browser and explicit targets is an error',
    );
  }
  if (raw.targets === undefined) {
    const browser = raw.browser ?? 'chromium';
    return [
      {
        name: 'web',
        index: 0,
        platform: 'web',
        browser,
        viewport: undefined,
        driver: DEFAULT_DRIVER_ID,
        driverTarget: { name: 'web', platform: 'web', browser },
      },
    ];
  }
  if (raw.targets.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'targets must not be empty');
  }
  const seen = new Set<string>();
  return raw.targets.map((target, index) => {
    if (typeof target.name !== 'string' || !TARGET_NAME_PATTERN.test(target.name)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target names are required and limited to ASCII letters, numbers, "_", "-", and "."`,
      );
    }
    if (seen.has(target.name)) {
      throw new ConfigurationError('INVALID_CONFIG', `duplicate target name "${target.name}"`);
    }
    seen.add(target.name);
    if (target.platform !== 'web') {
      throw new ConfigurationError(
        'PLATFORM_UNSUPPORTED',
        `target "${target.name}" requests platform "${target.platform}"; this v0 runner executes web targets only`,
      );
    }
    const webTarget = target as WebTarget;
    let driver: WellKnownDriverId | Driver;
    if (webTarget.driver === undefined) {
      driver = DEFAULT_DRIVER_ID;
    } else if (isWellKnownDriverId(webTarget.driver)) {
      driver = webTarget.driver;
    } else if (isDriverHandle(webTarget.driver)) {
      driver = webTarget.driver;
    } else {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${target.name}" driver must be ${wellKnownDriverIds()} or a defineDriver handle`,
      );
    }
    const browser = webTarget.browser ?? 'chromium';
    if (!['chromium', 'firefox', 'webkit'].includes(browser)) {
      throw new ConfigurationError('INVALID_CONFIG', `invalid browser "${browser}"`);
    }
    return {
      name: target.name,
      index,
      platform: 'web' as const,
      browser,
      viewport: webTarget.viewport,
      driver,
      driverTarget: {
        name: target.name,
        platform: 'web' as const,
        browser,
        ...(webTarget.viewport !== undefined ? { viewport: webTarget.viewport } : {}),
      },
    };
  });
}

function normalizeTests(tests: E2EConfig['tests']): readonly string[] {
  const list = tests === undefined ? ['tests/**/*.e2e.ts'] : typeof tests === 'string' ? [tests] : tests;
  if (list.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'tests must not be empty');
  }
  return [...new Set(list)];
}

function resolveProjectId(explicit: string | undefined, projectRoot: string): string {
  if (explicit !== undefined) {
    if (explicit.length === 0 || explicit.length > 256) {
      throw new ConfigurationError('INVALID_CONFIG', 'projectId must be 1 through 256 characters');
    }
    return explicit;
  }
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name;
    } catch {
      // fall through to hashed identity
    }
  }
  return `unportable-${sha256Hex(projectRoot).slice(0, 32)}`;
}

function resolveCredentials(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
): ReadonlyMap<string, ResolvedCredential> {
  const resolved = new Map<string, ResolvedCredential>();
  for (const [name, credential] of Object.entries(raw.credentials ?? {})) {
    const envPrefix = `E2E_USER_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
    const username = env[`${envPrefix}_USERNAME`] ?? credential.username;
    const password = env[`${envPrefix}_PASSWORD`] ?? credential.password;
    resolved.set(name, {
      name,
      username,
      password,
      allowedOrigins: credential.allowedOrigins,
    });
  }
  return resolved;
}

/**
 * SHA-256/JCS digest of resolved config after replacing credential material
 * with `{ secretName }` and env values with `{ envName }` (13-reporting.md).
 * Live objects (driver handles, model instances) are replaced by their stable
 * identity before the JSON clone, so they never enter the digest and cannot
 * make it nondeterministic across processes.
 */
function computeConfigDigest(raw: E2EConfig, projectId: string): string {
  // `agent` may be the executor itself; its digest identity is name/version,
  // which is exactly what survives the function-stripping JSON clone below.
  const rawAgent = raw.agent;
  const rawModel = rawAgent === undefined || isStepExecutor(rawAgent) ? undefined : rawAgent.model;
  const forClone: E2EConfig = isModelInstance(rawModel)
    ? {
        ...raw,
        agent: {
          ...(rawAgent as AgentConfig),
          model: {
            provider: rawModel.provider,
            modelId: rawModel.modelId,
            specificationVersion: rawModel.specificationVersion,
          },
        },
      }
    : raw;
  const sanitized: Record<string, unknown> = {
    ...(structuredCloneJsonSafe(forClone) as Record<string, unknown>),
    projectId,
  };
  if (raw.credentials !== undefined) {
    sanitized['credentials'] = Object.fromEntries(
      Object.entries(raw.credentials).map(([name, credential]) => [
        name,
        {
          username: credential.username,
          password: { secretName: name },
          ...(credential.allowedOrigins !== undefined
            ? { allowedOrigins: credential.allowedOrigins }
            : {}),
        },
      ]),
    );
  }
  if (raw.app?.command?.env !== undefined) {
    const app = sanitized['app'] as { command: { env: unknown } };
    app.command.env = Object.fromEntries(
      Object.keys(raw.app.command.env).map((key) => [key, { envName: key }]),
    );
  }
  if (raw.targets !== undefined) {
    sanitized['targets'] = raw.targets.map((target) => {
      if ('driver' in target && isDriverHandle(target.driver)) {
        const { driver, ...rest } = target;
        return {
          ...rest,
          driver: {
            id: driver.id,
            version: driver.version,
            platforms: driver.platforms,
            spiVersion: driver.spiVersion,
            capabilities: driver.capabilities,
          },
        };
      }
      return target;
    });
  }
  return canonicalDigest(sanitized);
}

function structuredCloneJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'function' ? undefined : item)) ??
      'null',
  );
}
