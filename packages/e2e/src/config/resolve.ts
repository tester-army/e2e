/** Config validation, defaults, and resolution. */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envFlag } from '../internal/env.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isStepExecutor } from '../agent/executor.ts';
import { boundedInt, positiveInt } from './validate.ts';
import type {
  ArtifactStore,
  ArtifactsConfig,
  BuiltinReporter,
  CacheMode,
  ConfiguredArtifactKind,
  E2EConfig,
  ModelInstance,
  Platform,
  Reporter,
  SecretProvider,
  Target,
  TraceCacheStore,
  VideoArtifactConfig,
} from '../types.ts';
import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import {
  isModelInstance,
  resolveAgentConfig,
  resolveLimits,
  type ResolvedAgentConfig,
  type ResolvedLimits,
  type ResolvedBaseLimits,
} from './agent.ts';
import { digestAppDeclaration, resolveTargetApp, type ResolvedApp } from './app.ts';

export type { ResolvedAgentConfig, ResolvedLimits } from './agent.ts';
export type { ResolvedApp } from './app.ts';

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: Platform;
  /** Validated engine; undefined for an agent-tools-only target. */
  readonly engine: EngineHandle | undefined;
  /** The app under test, resolved from the engine's declaration. */
  readonly app: ResolvedApp;
}

export interface ResolvedCredential {
  readonly name: string;
  readonly username: string;
  /** A static value, or a provider resolved fresh on every authorized fill. */
  readonly password: string | SecretProvider;
  readonly allowedOrigins: readonly string[] | undefined;
}

/**
 * How firmly the run asks for one artifact kind. The default set (screenshot
 * and trace) is `best-effort`: an engine without evidence capture records
 * none, and a recording that cannot be finalized is dropped quietly. A kind
 * named in the config, or added by `--video`, is `required`: an engine that
 * cannot produce it fails the run before any test starts, and a recording
 * that cannot be finalized is a cleanup failure the report shows.
 */
type ArtifactPolicy = 'best-effort' | 'required';

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
  /** Every artifact kind the run captures, in config order, with how firmly it is asked for. */
  readonly artifacts: ReadonlyMap<ConfiguredArtifactKind, ArtifactPolicy>;
  /** Host store every produced artifact is handed to; undefined keeps files local only. */
  readonly artifactStore: ArtifactStore | undefined;
  /** Which attempts keep their video: every one, or only those that did not pass. */
  readonly videoRetain: 'all' | 'on-failure';
  /** The built-in renderers in force: `--reporter` when given, else the config's ids. */
  readonly reporters: readonly BuiltinReporter[];
  /** The reporter objects the config names; `--reporter` never removes one. */
  readonly customReporters: readonly Reporter[];
  readonly testIdAttribute: string;
  /**
   * The agents unpinned tests run as, one result each: `agents.default`, or
   * the names `--agent` gave, in order and deduplicated. Never empty.
   */
  readonly agentNames: readonly string[];
  /** The first of `agentNames`: the run's agent where exactly one is wanted (`e2e explore`). */
  readonly agent: ResolvedAgentConfig;
  /** Every configured agent, `default` included, by name. */
  readonly agents: ReadonlyMap<string, ResolvedAgentConfig>;
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
  reporters?: readonly BuiltinReporter[];
  /** Trace cache mode override; `--no-cache` maps to `'off'`. */
  cache?: CacheMode;
  /** `--video`: adds the `video` artifact kind to whatever the config asks for. */
  video?: boolean;
  /** `--agent`: the configured agents unpinned tests run as, instead of `default` alone. */
  agents?: readonly string[];
}

const TARGET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const TARGET_KEYS = new Set(['name', 'platform', 'engine']);

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
  'agents',
  'cache',
  'limits',
  'credentials',
]);

const CACHE_KEYS = new Set(['mode', 'store', 'dir']);
const CACHE_MODES = new Set(['off', 'read-only', 'read-write']);

const APP_BELONGS_TO_ENGINE =
  'the app under test is declared by the engine: engine: playwright({ url }) for a browser, agentDevice({ platform, app }) for a device';

/** Keys from other runners' configs, each mapped to where that fact lives here. */
const FOREIGN_TOP_LEVEL_KEYS: Readonly<Record<string, string>> = {
  testDir: 'test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
  testMatch: 'test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
  app: APP_BELONGS_TO_ENGINE,
  url: APP_BELONGS_TO_ENGINE,
  baseURL: APP_BELONGS_TO_ENGINE,
  baseUrl: APP_BELONGS_TO_ENGINE,
  webServer: 'the runner starts the app from the engine options: playwright({ url, command: { executable, args } })',
  use: 'browser and app options are engine options: engine: playwright({ ... })',
  projects: 'one target per browser or device: targets: [{ engine }]',
  agent: 'agents are named: agents: { default: <what agent held> }; e2e run --agent <name> runs with another',
};

/** Keys authors put on a target that belong to its engine. */
const FOREIGN_TARGET_KEYS: ReadonlySet<string> = new Set([
  'app',
  'url',
  'baseURL',
  'baseUrl',
  'command',
  'appPath',
  'bundleId',
  'browser',
  'device',
]);

/** `; did you mean "targets"?` or a pointer to where a foreign key's fact lives. */
function unknownTopLevelKeyHint(key: string): string {
  const foreign = FOREIGN_TOP_LEVEL_KEYS[key];
  return foreign === undefined ? didYouMean(key, [...TOP_LEVEL_KEYS]) : `; ${foreign}`;
}

/** True when CI mode is active. */
export function isCiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'CI');
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
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown config key "${key}"${unknownTopLevelKeyHint(key)}`,
      );
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

  const timeout = positiveInt(raw.timeout, 'timeout', 'milliseconds') ?? 120_000;
  const launchTimeout = positiveInt(raw.launchTimeout, 'launchTimeout', 'milliseconds') ?? 60_000;
  const actionTimeout = positiveInt(raw.actionTimeout, 'actionTimeout', 'milliseconds') ?? 30_000;
  const assertionTimeout = positiveInt(raw.assertionTimeout, 'assertionTimeout', 'milliseconds') ?? 5_000;
  const cleanupTimeout = positiveInt(raw.cleanupTimeout, 'cleanupTimeout', 'milliseconds') ?? 30_000;

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

  const { artifacts, artifactStore, videoRetain } = resolveArtifactsConfig(raw, cli);
  const { reporters, customReporters } = resolveReporters(raw, cli);

  const testIdAttribute = raw.screen?.testIdAttribute ?? 'data-testid';
  const projectId = resolveProjectId(raw.projectId, options.projectRoot);
  const credentials = resolveCredentials(raw, env);
  // Limits first: the agent context budget is a limits key, and the resolved
  // observation budget is agent-owned, so the dependency runs one way.
  const baseLimits = resolveLimits(raw);
  const { agents, agentNames, agent } = resolveAgents(raw.agents, env, ci, baseLimits, cli.agents);
  // The report's ceiling is the largest any configured agent may use: a
  // pinned agent's calls are bounded by its own value, and the run-level
  // number must not read lower than what a step could actually send.
  const limits: ResolvedLimits = {
    ...baseLimits,
    maxObservationBytes: Math.max(...[...agents.values()].map((entry) => entry.maxObservationBytes)),
  };
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
    artifactStore,
    videoRetain,
    reporters,
    customReporters,
    testIdAttribute,
    agentNames,
    agent,
    agents,
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
 * learned unless the project says so. An explicit
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
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown cache config key "${key}"${didYouMean(key, [...CACHE_KEYS])}`,
        );
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

/** The default artifact set. `video` is opt-in and never part of it. */
const DEFAULT_ARTIFACT_KINDS = ['screenshot', 'trace'] as const;
const ARTIFACT_KINDS: readonly ConfiguredArtifactKind[] = ['screenshot', 'trace', 'video'];
const ARTIFACTS_KEYS = new Set(['kinds', 'store', 'video']);
const VIDEO_KEYS = new Set(['retain']);
const VIDEO_RETAIN_VALUES = ['all', 'on-failure'] as const;

/**
 * Resolves the `artifacts` key: a bare array of kinds, or `{ kinds, store,
 * video }` where `store` is the host seam every produced artifact is handed
 * to and `video` holds the recording options. Named kinds are required; the
 * default set (screenshot and trace) is best-effort; `--video` adds video as
 * a required kind on top of either. A store is a live value validated
 * structurally, like `cache.store`.
 */
function resolveArtifactsConfig(
  raw: E2EConfig,
  cli: CliOverrides,
): {
  artifacts: ReadonlyMap<ConfiguredArtifactKind, ArtifactPolicy>;
  artifactStore: ArtifactStore | undefined;
  videoRetain: 'all' | 'on-failure';
} {
  const value: unknown = raw.artifacts;
  let kinds: unknown = value;
  let store: ArtifactStore | undefined;
  let video: unknown;
  if (value !== undefined && !Array.isArray(value)) {
    if (!isArtifactsObject(value)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'artifacts must be an array of artifact kinds or { kinds, store, video }',
      );
    }
    for (const key of Object.keys(value)) {
      if (!ARTIFACTS_KEYS.has(key)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown artifacts config key "${key}"${didYouMean(key, [...ARTIFACTS_KEYS])}`,
        );
      }
    }
    kinds = value.kinds;
    store = value.store;
    video = value.video;
    if (store !== undefined && !isArtifactStore(store)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'artifacts.store must implement ArtifactStore: { put(artifact) }',
      );
    }
  }
  const resolved = (kinds ?? DEFAULT_ARTIFACT_KINDS) as readonly unknown[];
  if (!Array.isArray(resolved)) {
    throw new ConfigurationError('INVALID_CONFIG', 'artifacts kinds must be an array of artifact kinds');
  }
  for (const artifact of resolved) {
    if (!(ARTIFACT_KINDS as readonly unknown[]).includes(artifact)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown artifact kind "${String(artifact)}"`);
    }
  }
  // Video is never in the default set, so its presence is always a request,
  // whether the config named it or `--video` added it. Copied, never pushed:
  // `resolved` may be the default constant or the caller's own array.
  const policy: ArtifactPolicy = kinds === undefined ? 'best-effort' : 'required';
  const artifacts = new Map((resolved as readonly ConfiguredArtifactKind[]).map((kind) => [kind, policy] as const));
  if (cli.video === true) artifacts.set('video', 'required');
  return { artifacts, artifactStore: store, videoRetain: resolveVideoRetain(video) };
}

/** Validates the `artifacts.video` block; absent means every attempt keeps its recording. */
function resolveVideoRetain(value: unknown): 'all' | 'on-failure' {
  if (value === undefined) return 'all';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigurationError('INVALID_CONFIG', 'artifacts.video must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!VIDEO_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown artifacts.video config key "${key}"${didYouMean(key, [...VIDEO_KEYS])}`,
      );
    }
  }
  const retain = (value as VideoArtifactConfig).retain;
  if (retain === undefined) return 'all';
  if (!(VIDEO_RETAIN_VALUES as readonly unknown[]).includes(retain)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `artifacts.video.retain must be one of ${VIDEO_RETAIN_VALUES.join(', ')}, got ${JSON.stringify(retain)}`,
    );
  }
  return retain;
}

/** The `{ kinds, store }` form, as opposed to the bare kinds array. */
function isArtifactsObject(value: unknown): value is ArtifactsConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BUILTIN_REPORTERS: readonly BuiltinReporter[] = ['list', 'json', 'junit'];

/**
 * Splits `reporters` into the built-in ids and the reporter objects.
 * `--reporter` replaces the ids only: an object has no id to name on the
 * command line, so a CI flag choosing `list,junit` never drops the upload a
 * config asked for.
 */
function resolveReporters(
  raw: E2EConfig,
  cli: CliOverrides,
): { reporters: readonly BuiltinReporter[]; customReporters: readonly Reporter[] } {
  const configured = raw.reporters ?? ['list'];
  if (!Array.isArray(configured)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'reporters must be an array of reporter ids and reporter objects',
    );
  }
  const ids: BuiltinReporter[] = [];
  const customReporters: Reporter[] = [];
  for (const reporter of configured as readonly unknown[]) {
    if (typeof reporter === 'string') {
      if (!(BUILTIN_REPORTERS as readonly string[]).includes(reporter)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown reporter "${reporter}"; reporters are list, json, and junit${didYouMean(reporter, BUILTIN_REPORTERS)}`,
        );
      }
      ids.push(reporter as BuiltinReporter);
    } else if (isReporter(reporter)) {
      customReporters.push(reporter);
    } else {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'a reporter is a built-in id (list, json, junit) or an object with a name and an onEvent or onRunFinished method',
      );
    }
  }
  const reporters = cli.reporters ?? ids;
  if (reporters.includes('json') && reporters.includes('list')) {
    throw new ConfigurationError('INVALID_CONFIG', 'the json renderer cannot be combined with list');
  }
  return { reporters, customReporters };
}

/** Structural reporter check: a non-empty name and at least one handler, each a function when present. */
function isReporter(value: unknown): value is Reporter {
  if (typeof value !== 'object' || value === null) return false;
  const { name, onEvent, onRunFinished } = value as { name?: unknown; onEvent?: unknown; onRunFinished?: unknown };
  if (typeof name !== 'string' || name.length === 0) return false;
  const optionalFunction = (handler: unknown): boolean => handler === undefined || typeof handler === 'function';
  return optionalFunction(onEvent) && optionalFunction(onRunFinished) && (onEvent ?? onRunFinished) !== undefined;
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
      'targets is required: declare at least one target and the engine that drives it, ' +
        'e.g. targets: [{ engine }]',
    );
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'targets must be a non-empty array');
  }
  const seen = new Set<string>();
  const defaulted = new Set<string>();
  return raw.targets.map((target, index) => {
    // Errors raised before the name settles point at the entry itself.
    const where = typeof target.name === 'string' ? `target "${target.name}"` : `targets[${index}]`;
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.has(key)) {
        const hint = FOREIGN_TARGET_KEYS.has(key)
          ? `; ${APP_BELONGS_TO_ENGINE}`
          : didYouMean(key, [...TARGET_KEYS]);
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `${where} has unknown key "${key}"; a target is { name?, platform?, engine? }${hint}`,
        );
      }
    }
    if (target.engine !== undefined && !isEngineHandle(target.engine)) {
      const got = typeof target.engine === 'string' ? `the string ${JSON.stringify(target.engine)}` : `a ${typeof target.engine}`;
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} engine must be an engine handle, got ${got}; call the engine's factory: playwright({ url }) from @e2edev/playwright, agentDevice({ platform, app }) from @e2edev/agent-device, or your own defineEngine(...)`,
      );
    }
    const platform = resolvePlatform(target, where);
    const name = target.name === undefined ? platform : target.name;
    if (typeof name !== 'string' || !TARGET_NAME_PATTERN.test(name)) {
      const source = target.name === undefined ? ' (defaulted from the platform)' : '';
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid target name ${JSON.stringify(name)}${source}; target names are limited to ASCII letters, numbers, "_", "-", and "."`,
      );
    }
    if (seen.has(name)) {
      const hint =
        target.name === undefined || defaulted.has(name)
          ? '; a target without a name is named after its platform, so name one of them'
          : '';
      throw new ConfigurationError('INVALID_CONFIG', `duplicate target name "${name}"${hint}`);
    }
    seen.add(name);
    if (target.name === undefined) defaulted.add(name);
    return {
      name,
      index,
      platform,
      engine: target.engine,
      app: resolveTargetApp(name, target.engine, projectRoot),
    };
  });
}

/**
 * The target's platform: its own label, else the engine's declaration. Tool
 * packs are offered by the engine's platform while tests filter by the
 * target's, so a target that names one while its engine declares another is a
 * mistake, not an override.
 */
function resolvePlatform(target: Target, where: string): Platform {
  const declared = target.platform;
  if (declared !== undefined && (typeof declared !== 'string' || declared.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} platform must be a non-empty string`);
  }
  const inherited = target.engine?.platform;
  if (declared !== undefined && inherited !== undefined && declared !== inherited) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares platform "${declared}" but its engine ${target.engine?.name} drives "${inherited}"; drop the target's platform or make them agree`,
    );
  }
  const platform = declared ?? inherited;
  if (platform === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs a platform: ${
        target.engine === undefined ? 'it has no engine to inherit one from' : `engine ${target.engine.name} declares none`
      }; set platform on the target`,
    );
  }
  return platform;
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
 * with `{ secretName }` and env values with `{ envName }`.
 * Live objects (engine handles, model instances) are replaced by their stable
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

const DEFAULT_AGENT_NAME = 'default';
const AGENT_NAME_PATTERN = TARGET_NAME_PATTERN;

/**
 * Resolves `agents`: every named entry, and `default` even when the config
 * names none (the built-in agent, which then needs `createAgent({ model })`). The run's agents are
 * `default` alone unless `--agent` named others; an unknown name is a config
 * error before anything starts.
 */
function resolveAgents(
  raw: E2EConfig['agents'],
  env: NodeJS.ProcessEnv,
  ci: boolean,
  limits: ResolvedBaseLimits,
  selected: readonly string[] | undefined,
): { agents: ReadonlyMap<string, ResolvedAgentConfig>; agentNames: readonly string[]; agent: ResolvedAgentConfig } {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw) || isStepExecutor(raw))) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agents must be an object of agents by name: agents: { default: createAgent(...) }',
    );
  }
  const agents = new Map<string, ResolvedAgentConfig>();
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid agent name ${JSON.stringify(name)}: names are ASCII letters, numbers, "_", "-", or "."`,
      );
    }
    agents.set(name, resolveAgentConfig(value, env, ci, limits, `agents.${name}`));
  }
  if (!agents.has(DEFAULT_AGENT_NAME)) {
    agents.set(DEFAULT_AGENT_NAME, resolveAgentConfig(undefined, env, ci, limits));
  }
  // `--agent a --agent a` is one agent, not two results per test.
  const agentNames = selected === undefined || selected.length === 0 ? [DEFAULT_AGENT_NAME] : [...new Set(selected)];
  for (const name of agentNames) {
    if (agents.has(name)) continue;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `unknown agent "${name}"; configured: ${[...agents.keys()].join(', ')}${didYouMean(name, [...agents.keys()])}`,
    );
  }
  return { agents, agentNames, agent: agents.get(agentNames[0]!)! };
}

/** The artifact kinds as the digest sees them: no store, no video. */
function digestedArtifactKinds(artifacts: NonNullable<E2EConfig['artifacts']>): ConfiguredArtifactKind[] {
  const kinds = isArtifactsObject(artifacts) ? artifacts.kinds : artifacts;
  return (kinds ?? [...DEFAULT_ARTIFACT_KINDS]).filter((kind) => kind !== 'video');
}

function computeConfigDigest(raw: E2EConfig, projectId: string): string {
  // An agent may be the executor itself; its digest identity is name/version,
  // which is exactly what survives the function-stripping JSON clone below.
  // Every model slot is reduced to its identity: a live instance carries
  // provider settings (and possibly credentials) that must never be digested.
  // Live values are reduced before the clone, not after: a store or a
  // reporter may hold a client whose object graph JSON cannot serialize.
  //
  // An artifact store is a live value: only the kinds are configuration, so
  // the array and object forms digest identically and a host store never
  // enters the digest. Nor does video: recording a run must never invalidate
  // the traces it would otherwise replay, so the digest reads the same kinds
  // with or without it and ignores the `video` options block. A reporter
  // object changes nothing about what a run records, so it never enters the
  // digest either; the built-in ids digest as they always have, so adding a
  // reporter to a config leaves its cache valid.
  const forClone: Record<string, unknown> = {
    ...raw,
    ...(raw.artifacts === undefined ? {} : { artifacts: digestedArtifactKinds(raw.artifacts) }),
    ...(Array.isArray(raw.reporters)
      ? { reporters: raw.reporters.filter((reporter) => typeof reporter === 'string') }
      : {}),
    ...(raw.agents === undefined
      ? {}
      : {
          agents: Object.fromEntries(
            Object.entries(raw.agents).map(([name, entry]) => [
              name,
              isStepExecutor(entry)
                ? entry
                : {
                    ...entry,
                    ...(isModelInstance(entry.model) ? { model: modelIdentity(entry.model) } : {}),
                    ...(isModelInstance(entry.visionModel) ? { visionModel: modelIdentity(entry.visionModel) } : {}),
                  },
            ]),
          ),
        }),
  };
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
  if (raw.targets !== undefined) {
    sanitized['targets'] = raw.targets.map((target) => {
      // An engine handle holds live functions; its digest identity is the
      // declaration - name, version, contract version, the platform it
      // drives (a named target inherits it, so two workers whose engines
      // declare different platforms must not agree on the digest), capability
      // set, and what it declares about the app under test.
      if (isEngineHandle(target.engine)) {
        const { engine, ...rest } = target;
        return {
          ...rest,
          engine: {
            name: engine.name,
            ...(engine.version === undefined ? {} : { version: engine.version }),
            spiVersion: engine.spiVersion,
            ...(engine.platform === undefined ? {} : { platform: engine.platform }),
            ...(engine.workers === undefined ? {} : { workers: engine.workers }),
            capabilities: [...engine.capabilities].toSorted(),
            app: digestAppDeclaration(engine.app ?? {}),
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
