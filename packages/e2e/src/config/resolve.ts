/** Config validation, defaults, and resolution (spec 05-config.md). */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import { isStepExecutor } from '../agent/executor.ts';
import { boundedInt, positiveInt } from './validate.ts';
import type {
  ArtifactsConfig,
  ArtifactStore,
  CacheMode,
  E2EConfig,
  ModelInstance,
  Platform,
  SecretProvider,
  TraceCacheStore,
} from '../types.ts';
import { isBackendHandle, type BackendHandle } from '../backend/index.ts';
import {
  isModelInstance,
  resolveAgentConfig,
  resolveLimits,
  type ResolvedAgentConfig,
  type ResolvedLimits,
} from './agent.ts';
import { digestAppDeclaration, resolveTargetApp, type ResolvedApp } from './app.ts';

export type { ResolvedAgentConfig, ResolvedLimits } from './agent.ts';
export type { ResolvedApp } from './app.ts';

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: Platform;
  /** Validated backend; undefined for an agent-tools-only target. */
  readonly backend: BackendHandle | undefined;
  /** The app under test, resolved from the backend's declaration. */
  readonly app: ResolvedApp;
}

export interface ResolvedCredential {
  readonly name: string;
  readonly username: string;
  /** A static value, or a provider resolved fresh on every authorized fill. */
  readonly password: string | SecretProvider;
  readonly allowedOrigins: readonly string[] | undefined;
}

export interface ResolvedConfig {
  readonly specVersion: '0.1';
  readonly projectId: string;
  readonly projectRoot: string;
  readonly configPath: string | undefined;
  readonly ci: boolean;
  readonly targets: readonly ResolvedTarget[];
  readonly tests: readonly string[];
  readonly timeout: number;
  readonly launchTimeout: number;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
  readonly cleanupTimeout: number;
  readonly retries: number;
  readonly workers: number;
  readonly artifacts: readonly ('trace' | 'screenshot')[];
  /** True when artifact kinds were set in config, so a backend that cannot produce one is an error. */
  readonly artifactsExplicit: boolean;
  /** Host store every produced artifact is handed to; undefined keeps files local only. */
  readonly artifactStore: ArtifactStore | undefined;
  readonly reporters: readonly ('list' | 'json' | 'junit')[];
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

/**
 * Flags that replace config keys, so workers re-resolving the config file
 * apply them too. `--headed` and `--artifacts` are run options, not config
 * overrides, and travel separately.
 */
export interface CliOverrides {
  retries?: number;
  workers?: number;
  reporters?: readonly ('list' | 'json' | 'junit')[];
  /** Trace cache mode override; `--no-cache` maps to `'off'`. */
  cache?: CacheMode;
}

const TARGET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const TARGET_KEYS = new Set(['name', 'platform', 'backend']);

const TOP_LEVEL_KEYS = new Set([
  'specVersion',
  'projectId',
  'targets',
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

  const targets = resolveTargets(raw, options.projectRoot);
  const tests = normalizeTests(raw.tests);

  const timeout = positiveInt(raw.timeout, 'timeout') ?? 120_000;
  const launchTimeout = positiveInt(raw.launchTimeout, 'launchTimeout') ?? 60_000;
  const actionTimeout = positiveInt(raw.actionTimeout, 'actionTimeout') ?? 30_000;
  const assertionTimeout = positiveInt(raw.assertionTimeout, 'assertionTimeout') ?? 5_000;
  const cleanupTimeout = positiveInt(raw.cleanupTimeout, 'cleanupTimeout') ?? 30_000;

  // CLI overrides obey the same bounds as the config keys they replace: a
  // `--workers 0` would otherwise plan work no worker can ever take.
  const retries =
    boundedInt(cli.retries, '--retries', 0, 10) ??
    boundedInt(raw.retries, 'retries', 0, 10) ??
    (ci ? 1 : 0);
  const workers =
    boundedInt(cli.workers, '--workers', 1, 1024) ??
    boundedInt(raw.workers, 'workers', 1, 1024) ??
    (ci ? 1 : Math.max(1, Math.floor(os.availableParallelism() / 2)));

  const { artifacts, artifactsExplicit, artifactStore } = resolveArtifactsConfig(raw);
  const reporters = cli.reporters ?? raw.reporters ?? (['list'] as const);
  if (!Array.isArray(reporters)) {
    throw new ConfigurationError('INVALID_CONFIG', 'reporters must be an array of reporter ids');
  }
  for (const reporter of reporters) {
    if (!['list', 'json', 'junit'].includes(reporter)) {
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
    artifactsExplicit,
    artifactStore,
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
 * CI demotes the *defaulted* mode from `read-write` to `read-only`: a
 * committed cache is untrusted input, and a CI run never publishes what it
 * learned unless the project says so (spec 10-determinism.md). An explicit
 * `read-write` in the config is that statement of trust and is honored as
 * written, as is a host-supplied `cache.store`, which states its own trust
 * through the store's `writable` flag.
 */
function resolveCacheConfig(
  raw: E2EConfig,
  ci: boolean,
  projectRoot: string,
  cliMode: CacheMode | undefined,
): ResolvedCacheConfig {
  const value = raw.cache;
  let mode: CacheMode = 'read-write';
  /** Whether the config named a mode; only a defaulted mode is demoted in CI. */
  let explicit = false;
  let store: TraceCacheStore | undefined;
  let dir: string | undefined;
  if (typeof value === 'string') {
    mode = value;
    explicit = true;
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
    explicit = value.mode !== undefined;
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
  if (ci && mode === 'read-write' && !explicit && store === undefined) mode = 'read-only';
  return {
    mode,
    store,
    dir: path.resolve(projectRoot, dir ?? path.join('.e2e', 'cache')),
  };
}

const ARTIFACT_KINDS = ['screenshot', 'trace'] as const;
const ARTIFACTS_KEYS = new Set(['kinds', 'store']);

/**
 * Resolves the `artifacts` key: a bare array of kinds, or `{ kinds, store }`
 * where `store` is the host seam every produced artifact is handed to
 * (spec 13-reporting.md). Kinds default to screenshot and trace; a store is a
 * live value validated structurally, like `cache.store`.
 */
function resolveArtifactsConfig(raw: E2EConfig): {
  artifacts: readonly ('trace' | 'screenshot')[];
  artifactsExplicit: boolean;
  artifactStore: ArtifactStore | undefined;
} {
  const value: unknown = raw.artifacts;
  let kinds: unknown = value;
  let store: ArtifactStore | undefined;
  if (value !== undefined && !Array.isArray(value)) {
    if (!isArtifactsObject(value)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'artifacts must be an array of artifact kinds or { kinds, store }',
      );
    }
    for (const key of Object.keys(value)) {
      if (!ARTIFACTS_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown artifacts config key "${key}"`);
      }
    }
    kinds = value.kinds;
    store = value.store;
    if (store !== undefined && !isArtifactStore(store)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'artifacts.store must implement ArtifactStore: { put(artifact) }',
      );
    }
  }
  const explicit = kinds !== undefined;
  const resolved = (kinds ?? ARTIFACT_KINDS) as readonly unknown[];
  if (!Array.isArray(resolved)) {
    throw new ConfigurationError('INVALID_CONFIG', 'artifacts kinds must be an array of artifact kinds');
  }
  for (const artifact of resolved) {
    if (!(ARTIFACT_KINDS as readonly unknown[]).includes(artifact)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown artifact kind "${String(artifact)}"`);
    }
  }
  return {
    artifacts: resolved as readonly ('trace' | 'screenshot')[],
    artifactsExplicit: explicit,
    artifactStore: store,
  };
}

/** The `{ kinds, store }` form, as opposed to the bare kinds array. */
function isArtifactsObject(value: unknown): value is ArtifactsConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactStore(value: unknown): value is ArtifactStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { put?: unknown }).put === 'function'
  );
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


function resolveTargets(raw: E2EConfig, projectRoot: string): readonly ResolvedTarget[] {
  if (raw.targets === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'targets is required: declare at least one target and the backend that drives it, ' +
        'e.g. targets: [{ name, platform, backend }]',
    );
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'targets must be a non-empty array');
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
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.has(key)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `target "${target.name}" has unknown key "${key}"; a target is { name, platform, backend? }`,
        );
      }
    }
    if (typeof target.platform !== 'string' || target.platform.trim() === '') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${target.name}" requires a non-empty platform`,
      );
    }
    if (target.backend !== undefined && !isBackendHandle(target.backend)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${target.name}" backend must be a defineBackend(...) handle`,
      );
    }
    return {
      name: target.name,
      index,
      platform: target.platform,
      backend: target.backend,
      app: resolveTargetApp(target.name, target.backend, projectRoot),
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
    // An env override always wins, including over a provider: the operator
    // rotating a credential must not need to know how it was configured.
    const password = env[`${envPrefix}_PASSWORD`] ?? credential.password;
    if ((typeof password !== 'string' && typeof password !== 'function') || password === '') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `credential "${name}" password must be a non-empty string or a provider function`,
      );
    }
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
 * Live objects (backend handles, model instances) are replaced by their stable
 * identity before the JSON clone, so they never enter the digest and cannot
 * make it nondeterministic across processes.
 */
/** The digest-stable identity of a live model instance. */
function modelIdentity(model: ModelInstance): Record<string, string> {
  return {
    provider: model.provider,
    modelId: model.modelId,
    specificationVersion: model.specificationVersion,
  };
}

function computeConfigDigest(raw: E2EConfig, projectId: string): string {
  // `agent` may be the executor itself; its digest identity is name/version,
  // which is exactly what survives the function-stripping JSON clone below.
  // Every model slot is reduced to its identity: a live instance carries
  // provider settings (and possibly credentials) that must never be digested.
  const rawAgent = raw.agent;
  const forClone: Record<string, unknown> = {
    ...raw,
    ...(rawAgent === undefined || isStepExecutor(rawAgent)
      ? {}
      : {
          agent: {
            ...rawAgent,
            ...(isModelInstance(rawAgent.model) ? { model: modelIdentity(rawAgent.model) } : {}),
            ...(isModelInstance(rawAgent.visionModel)
              ? { visionModel: modelIdentity(rawAgent.visionModel) }
              : {}),
          },
        }),
  };
  const sanitized: Record<string, unknown> = {
    ...(structuredCloneJsonSafe(forClone) as Record<string, unknown>),
    projectId,
  };
  // An artifact store is a live value: only the kinds are configuration, so
  // the array and object forms digest identically and a host store never
  // enters the digest.
  if (isArtifactsObject(raw.artifacts)) {
    sanitized['artifacts'] = raw.artifacts.kinds ?? [...ARTIFACT_KINDS];
  }
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
  if (raw.targets !== undefined) {
    sanitized['targets'] = raw.targets.map((target) => {
      // A backend handle holds live functions; its digest identity is the
      // declaration - name, version, contract version, capability set, and
      // what it declares about the app under test.
      if (isBackendHandle(target.backend)) {
        const { backend, ...rest } = target;
        return {
          ...rest,
          backend: {
            name: backend.name,
            ...(backend.version === undefined ? {} : { version: backend.version }),
            spiVersion: backend.spiVersion,
            capabilities: [...backend.capabilities].toSorted(),
            app: digestAppDeclaration(backend.app ?? {}),
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
