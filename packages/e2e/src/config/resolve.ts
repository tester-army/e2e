/** Config validation, defaults, and resolution. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envFlag } from '../internal/env.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import { realpathOfExisting } from '../internal/paths.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isScreenshotMode, SCREENSHOT_MODES } from '../internal/screenshot-mode.ts';
import { isRecordingMode, legacyTraceSpelling, RECORDING_MODES, type RecordingKind, type ResolvedRecording } from '../internal/recording-modes.ts';
import { BUILTIN_REPORTER_LIST, BUILTIN_REPORTERS, isBuiltinReporter } from '../report/builtin.ts';
import { isStepExecutor } from '../agent/executor.ts';
import { compileGlob, compileGlobList, literalPrefix } from '../internal/globs.ts';
import { boundedInt, describeValue, positiveInt } from './validate.ts';
import type {
  ArtifactStore,
  ArtifactsConfig,
  BuiltinReporter,
  CacheMode,
  E2EConfig,
  ModelInstance,
  Reporter,
  SecretProvider,
  SecretPurpose,
  RecordingMode,
  ScreenshotMode,
  EvidenceConfig,
  CacheStore,
} from '../types.ts';
import { isModelInstance, resolveAgentConfig, runLimits, type ResolvedAgentConfig, type ResolvedLimits } from './agent.ts';
import { bindTargets, digestTargets, resolveTargets, TARGET_NAME_PATTERN, type PortAssignments, type ResolvedTarget } from './targets.ts';
import { credentialNamed, credentialSecretName, envName, isSecretValue, secretValueProblem } from './secrets.ts';

export type { ResolvedAgentConfig, ResolvedLimits } from './agent.ts';
export type { ResolvedApp } from './app.ts';
export type { PortAssignments, ResolvedTarget } from './targets.ts';

/** A named account. */
export interface ResolvedCredential {
  readonly name: string;
  readonly username: string;
  /** The account's password, the secret named `<name>.password`. */
  readonly password: ResolvedSecret;
}

/** One value the model never sees, from `config.secrets` or a credential's password. */
export interface ResolvedSecret {
  readonly name: string;
  readonly purpose: SecretPurpose;
  /** A static value, or a provider resolved fresh on every authorized fill. */
  readonly value: string | SecretProvider;
}

export interface ResolvedConfig {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly configPath: string | undefined;
  readonly ci: boolean;
  readonly targets: readonly ResolvedTarget[];
  /** The free ports the run assigned (`assignPorts`), by target name; empty until it did. */
  readonly ports: PortAssignments;
  readonly tests: readonly string[];
  readonly timeout: number;
  readonly launchTimeout: number;
  readonly actionTimeout: number;
  readonly assertionTimeout: number;
  readonly cleanupTimeout: number;
  readonly retries: number;
  readonly failOnSkippedFailure: boolean;
  readonly workers: number;
  /** Host store every produced artifact is handed to; undefined keeps files local only. */
  readonly artifactStore: ArtifactStore | undefined;
  /** Absolute directory the run writes its results to: `--output`, else the config's `output`, else `<projectRoot>/.e2e`. */
  readonly output: string;
  /** The built-in renderers in force: `--reporter` when given, else the config's ids. */
  readonly reporters: readonly BuiltinReporter[];
  /** The reporter objects the config names; `--reporter` never removes one. */
  readonly customReporters: readonly Reporter[];
  /** The evidence pack the run writes; undefined when evidence is off. */
  readonly evidence: ResolvedEvidence | undefined;
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
  /** The `config.secrets` entries by name: what `secrets.get()` and an engine option take. */
  readonly secrets: ReadonlyMap<string, ResolvedSecret>;
  /**
   * Every secret the run holds, by name: the `config.secrets` entries and
   * every credential's password. What fills, the ledger, and redaction read.
   */
  readonly allSecrets: ReadonlyMap<string, ResolvedSecret>;
  readonly configDigest: string;
}

/** Where the run's evidence pack goes, and the profile it is validated at. */
export interface ResolvedEvidence {
  /** Absolute directory the `<runId>.evidence` pack is written in. */
  readonly outDir: string;
  readonly profile: 'L0' | 'L1';
}

/**
 * The resolved replay cache posture. Like executors and model instances, a
 * custom store never crosses a process boundary: workers re-resolve the
 * config module and construct their own.
 */
export interface ResolvedCacheConfig {
  readonly mode: CacheMode;
  /** Custom entry store; undefined selects the file store at `dir`. */
  readonly store: CacheStore | undefined;
  /** Absolute file store directory. */
  readonly dir: string;
  /**
   * A recording that no longer replays fails its step with `REPLAY_STALE`
   * instead of handing off: false, or which knobs turned that on, since a
   * re-recording has to turn each of them off.
   */
  readonly strict: false | CacheStrictSource;
}

/** What turned `cache.strict` on for the run: the config key, the `--strict-cache` flag, or both. */
export interface CacheStrictSource {
  readonly config: boolean;
  readonly flag: boolean;
}

/**
 * Flags that replace config keys, so workers re-resolving the config file
 * apply them too. `--headed` is a run option, not a config
 * override, and travels separately.
 */
export interface CliOverrides {
  retries?: number;
  workers?: number;
  reporters?: readonly BuiltinReporter[];
  /** Replay cache mode override; `--no-cache` maps to `'off'`. */
  cache?: CacheMode;
  /** `--strict-cache`: turns `cache.strict` on for the run. */
  cacheStrict?: boolean;
  /** `--output <dir>`: the results directory for this run, over the config's `output`. */
  output?: string;
  /** `--trace [mode]`: which attempts record a trace, over the config's and every target's `trace`. */
  trace?: RecordingMode;
  /** `--video [mode]`: which attempts record a video, over the config's and every target's `video`. */
  video?: RecordingMode;
  /** `--screenshot <mode>`: which steps the runner screenshots, over the config's and every target's `screenshot`. */
  screenshot?: ScreenshotMode;
  /** `--no-evidence`: the run writes no evidence pack, whatever the config and `E2E_EVIDENCE` say. */
  evidence?: false;
  /** `--agent`: the configured agents unpinned tests run as, instead of `default` alone. */
  agents?: readonly string[];
}

const TOP_LEVEL_KEYS = new Set([
  'projectId',
  'targets',
  'tests',
  'timeout',
  'launchTimeout',
  'actionTimeout',
  'assertionTimeout',
  'cleanupTimeout',
  'retries',
  'failOnSkippedFailure',
  'workers',
  'artifacts',
  'output',
  'trace',
  'video',
  'screenshot',
  'evidence',
  'reporters',
  'agents',
  'cache',
  'credentials',
  'secrets',
]);

const CACHE_KEYS = new Set(['mode', 'store', 'dir', 'strict']);
const CACHE_MODES = new Set(['off', 'read-only', 'read-write']);

const APP_BELONGS_TO_TARGET =
  "the app under test is declared on its target: targets: [{ engine: web(), app: { url } }] for a browser, targets: [{ engine: mobile({ platform }), app: { bundleId } }] for a device";

/** Keys this runner used to accept, each mapped to what replaces it. */
const REMOVED_TOP_LEVEL_KEYS: ReadonlyMap<string, string> = new Map([
  ['specVersion', 'delete it; the runner version is the format version'],
  [
    'limits',
    'set maxInputTokens on each agent (it was limits.maxModelTokensPerCall); the runner fixes maxAgentContextBytes, maxLedgerBytes, and maxEventsPerStep',
  ],
]);

/** Keys from other runners' configs, each mapped to where that fact lives here. */
const FOREIGN_TOP_LEVEL_KEYS: Readonly<Record<string, string>> = {
  testDir: 'test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
  testMatch: 'test files are selected by tests, a glob such as "tests/**/*.e2e.ts"',
  app: APP_BELONGS_TO_TARGET,
  url: APP_BELONGS_TO_TARGET,
  baseURL: APP_BELONGS_TO_TARGET,
  baseUrl: APP_BELONGS_TO_TARGET,
  webServer: 'the runner starts the app from the target: targets: [{ engine: web(), app: { url, command: { executable, args } } }]',
  use: "browser options are engine options (engine: web({ ... })), and the app under test is the target's app: { url }",
  projects: 'one target per browser or device: targets: [{ engine }]',
  agent: 'agents are named: agents: { default: <what agent held> }; e2e run --agent <name> runs with another',
  screen: 'the test-id attribute is an engine option: engine: web({ testIdAttribute })',
};

/** `; did you mean "targets"?` or a pointer to where a foreign key's fact lives. */
function unknownTopLevelKeyHint(key: string): string {
  const foreign = FOREIGN_TOP_LEVEL_KEYS[key];
  return foreign === undefined ? didYouMean(key, [...TOP_LEVEL_KEYS]) : `; ${foreign}`;
}

/** True when CI mode is active. */
export function isCiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'CI');
}

/**
 * Resolves a raw config object plus environment into an immutable resolved
 * config, without the run's ports: a free port reads 0, as declared, which
 * is what identities and the digest key on. `assignPorts` puts a run's
 * ports in.
 */
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
    const removed = REMOVED_TOP_LEVEL_KEYS.get(key);
    if (removed !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `${key} was removed: ${removed}`);
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown config key "${key}"${unknownTopLevelKeyHint(key)}`,
      );
    }
  }

  const recordings = runRecordings(raw, cli, ci);
  const evidenceOn = evidenceEnabled(raw.evidence, env, cli);
  const screenshot = runScreenshot(raw, cli, evidenceOn);
  const targets = resolveTargets(raw.targets, options.projectRoot, (target, where) => ({
    trace: targetRecording(recordings.trace, target.trace, `${where} trace`, 'trace'),
    video: targetRecording(recordings.video, target.video, `${where} video`, 'video'),
    screenshot: targetScreenshot(screenshot, target.screenshot, `${where} screenshot`),
  }));
  const tests = normalizeTests(raw.tests, options.projectRoot);

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

  const failOnSkippedFailure = raw.failOnSkippedFailure === undefined ? false : raw.failOnSkippedFailure;
  if (typeof failOnSkippedFailure !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'failOnSkippedFailure must be a boolean');
  }

  const artifactStore = resolveArtifactStore(raw);
  const { reporters, customReporters } = resolveReporters(raw, cli);

  const projectId = resolveProjectId(raw.projectId, options.projectRoot);
  const { credentials, secrets, allSecrets } = resolveSecrets(raw, env);
  checkEngineSecrets(targets, secrets, credentials);
  const { agents, agentNames, agent } = resolveAgents(raw.agents, cli.agents);
  const limits = runLimits(agents.values());
  const cache = resolveCacheConfig(raw, ci, options.projectRoot, cli.cache, cli.cacheStrict === true);
  const output = resolveOutput(raw.output, cli.output, options.projectRoot, cache.dir, tests);
  const evidence = evidenceOn ? resolveEvidence(raw.evidence, options.projectRoot, output, cache.dir) : undefined;

  const resolved: ResolvedConfig = {
    projectId,
    projectRoot: options.projectRoot,
    configPath: options.configPath,
    ci,
    targets,
    ports: {},
    tests,
    timeout,
    launchTimeout,
    actionTimeout,
    assertionTimeout,
    cleanupTimeout,
    retries,
    failOnSkippedFailure,
    workers,
    artifactStore,
    output,
    reporters,
    customReporters,
    evidence,
    agentNames,
    agent,
    agents,
    cache,
    limits,
    credentials,
    secrets,
    allSecrets,
    configDigest: computeConfigDigest(raw, projectId, targets),
  };
  return resolved;
}

/**
 * The config on the free ports the run assigned: each target's app resolved
 * again on its port. Pure, so the runner and each worker reach the same URLs
 * from the same config and ports; the digest and the identities stand,
 * because the ports never enter them.
 */
export function assignPorts(config: ResolvedConfig, ports: PortAssignments): ResolvedConfig {
  return { ...config, targets: bindTargets(config.targets, config.projectRoot, ports), ports };
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
  cliStrict: boolean,
): ResolvedCacheConfig {
  const value = raw.cache;
  let mode: CacheMode = 'read-write';
  /** Whether the config named a mode; only a defaulted mode is demoted in CI. */
  let explicit = false;
  let store: CacheStore | undefined;
  let dir: string | undefined;
  let strict = false;
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
    if (store !== undefined && !isCacheStore(store)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'cache.store must implement CacheStore: { writable, read(keyHash), write(keyHash, payload) }',
      );
    }
    if (value.dir !== undefined) {
      if (typeof value.dir !== 'string' || value.dir.trim() === '') {
        throw new ConfigurationError('INVALID_CONFIG', 'cache.dir must be a non-empty path');
      }
      dir = value.dir;
    }
    if (value.strict !== undefined) {
      if (typeof value.strict !== 'boolean') {
        throw new ConfigurationError('INVALID_CONFIG', `cache.strict must be a boolean, got ${JSON.stringify(value.strict)}`);
      }
      strict = value.strict;
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
    strict: strict || cliStrict ? { config: strict, flag: cliStrict } : false,
  };
}

/** The directories under the output a run clears or owns, which nothing else may live in. */
const OUTPUT_OWNED_DIRS = ['artifacts', 'sessions', 'videos'] as const;

/** Whether `inner` is `outer` or a path below it. */
function isWithin(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The nearest of `target` and its ancestors that exists, or undefined when none does. */
function nearestExisting(target: string): string | undefined {
  for (let current = target; ; current = path.dirname(current)) {
    if (existsSync(current)) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * Resolves the results directory, `--output` over the config's `output`,
 * from the project root. A run clears `<output>/artifacts` and writes over
 * its reports, so the directory must be one it can own: a directory (or a
 * path that does not exist yet) inside the project root and not the root
 * itself, not holding the directory a test glob scans, not the cache
 * directory or inside it, and not wrapping the cache in a directory the run
 * clears or owns. Every path is compared through the filesystem, with the
 * symlinks of its nearest existing ancestor resolved and a dangling one
 * followed to where it points, so one directory spelled through a symlink
 * (`/tmp` and `/private/tmp` on macOS) is the same directory on both sides.
 */
function resolveOutput(
  configured: unknown,
  flag: string | undefined,
  projectRoot: string,
  cacheDir: string,
  tests: readonly string[],
): string {
  const where = flag === undefined ? 'output' : '--output';
  const value: unknown = flag ?? configured;
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} must be a non-empty path relative to the project root, got ${describeValue(value)}`);
  }
  const output = path.resolve(projectRoot, (value as string | undefined) ?? '.e2e');
  const named = value === undefined ? `${where} ".e2e" (the default)` : `${where} ${JSON.stringify(value)}`;
  const refuse = (reason: string): never => {
    throw new ConfigurationError('INVALID_CONFIG', `${named} ${reason}`);
  };
  const root = realpathOfExisting(projectRoot);
  const real = realpathOfExisting(output);
  const cache = realpathOfExisting(cacheDir);
  if (real === root) refuse("is the project root; the run clears <output>/artifacts, so name a directory of its own, such as '.e2e'");
  if (!isWithin(real, root)) refuse(`is outside the project root ${projectRoot}; name a directory inside it`);
  const existing = nearestExisting(output);
  if (existing !== undefined && !statSync(existing).isDirectory()) {
    refuse(
      existing === output
        ? 'is a file; name a directory, which the run creates when it is missing'
        : `is under the file ${path.relative(root, realpathOfExisting(existing))}; name a directory, which the run creates when it is missing`,
    );
  }
  if (isWithin(real, cache)) refuse(`is the cache directory ${path.relative(root, cache)} or inside it; keep results and the replay cache apart`);
  for (const owned of OUTPUT_OWNED_DIRS) {
    if (isWithin(cache, realpathOfExisting(path.join(output, owned)))) {
      refuse(`would hold cache.dir ${path.relative(root, cache)} under ${owned}/, which the run owns; move cache.dir or the output`);
    }
  }
  for (const pattern of tests) {
    if (pattern.startsWith('!')) continue;
    const glob = compileGlob(pattern);
    const names = literalPrefix(glob);
    const scanned = path.join(projectRoot, ...(names.length === glob.segments.length ? names.slice(0, -1) : names));
    if (isWithin(realpathOfExisting(scanned), real)) {
      refuse(`holds ${path.relative(projectRoot, scanned) || '.'}, where the tests glob ${JSON.stringify(pattern)} finds test files; name a directory outside it`);
    }
  }
  return output;
}

const ARTIFACTS_KEYS = new Set(['store']);

/** Where a video fact lives now, for a config that still says it the old way. */
const VIDEO_MOVED =
  "video is its own option: video: 'on' in the config or on a target, video: 'retain-on-failure' to keep only failed attempts' recordings, or --video [mode] for one run";

/** The modes, as a sentence fragment every message that names one reads. */
const MODES_LIST = RECORDING_MODES.join(', ');

/**
 * What replaces the removed recording facts of `artifacts`, read together:
 * the kinds list (bare or as `kinds`, absent when the config had none) and
 * the `trace` block. A list holding `trace` beside `trace: { record:
 * 'retries' }` meant retries only, so the two name one mode between them,
 * and a list without `trace` recorded none whatever the block said. Then the
 * video option for a `video` kind, and the failure screenshot a list without
 * `screenshot` used to turn off.
 */
function removedRecordingReplacement(kinds: readonly unknown[] | undefined, trace: unknown): string {
  const traced = kinds === undefined || kinds.includes('trace');
  const mode = traced ? (legacyTraceSpelling(trace)?.mode ?? 'on') : 'off';
  const parts = [`write trace: '${mode}' at the config root instead (the modes are ${MODES_LIST})`];
  if (kinds?.includes('video') === true) parts.push(VIDEO_MOVED);
  if (kinds !== undefined && !kinds.includes('screenshot')) parts.push('failure screenshots are always captured now');
  return parts.join('; ');
}

/**
 * Resolves the `artifacts` key, `{ store }`: the host seam every produced
 * artifact is handed to, a live value validated structurally like
 * `cache.store`. What is recorded is not an artifacts fact: the old kinds
 * list (bare or as `kinds`) and the `trace` block are refused with the
 * `trace` mode they meant, and `video` with the option that replaced it.
 */
function resolveArtifactStore(raw: E2EConfig): ArtifactStore | undefined {
  const value: unknown = raw.artifacts;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new ConfigurationError('INVALID_CONFIG', `artifacts no longer lists kinds: ${removedRecordingReplacement(value, undefined)}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'artifacts must be { store }');
  }
  const block = value as Record<string, unknown>;
  const removed = (['kinds', 'trace'] as const).filter((key) => key in block);
  if (removed.length > 0) {
    const kinds = Array.isArray(block['kinds']) ? (block['kinds'] as readonly unknown[]) : 'kinds' in block ? [] : undefined;
    const keys = removed.map((key) => `artifacts.${key}`).join(' and ');
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${keys} ${removed.length === 1 ? 'was' : 'were'} removed: ${removedRecordingReplacement(kinds, block['trace'])}`,
    );
  }
  for (const key of Object.keys(block)) {
    if (key === 'video') throw new ConfigurationError('INVALID_CONFIG', `artifacts.video was removed: ${VIDEO_MOVED}`);
    if (!ARTIFACTS_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown artifacts config key "${key}"${didYouMean(key, [...ARTIFACTS_KEYS])}`,
      );
    }
  }
  const store = (value as ArtifactsConfig).store;
  if (store !== undefined && !isArtifactStore(store)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'artifacts.store must implement ArtifactStore: { put(artifact), putLink?(link) }',
    );
  }
  return store;
}

/** Checks one `trace` or `video` value: a mode, or undefined when the key is unset. */
function recordingMode(value: unknown, where: string, kind: RecordingKind): RecordingMode | undefined {
  if (value === undefined) return undefined;
  if (!isRecordingMode(value)) {
    const legacy = kind === 'trace' ? legacyTraceSpelling(value) : undefined;
    if (legacy !== undefined) {
      const spelled = where.startsWith('--') ? `${where} ${legacy.mode}` : `trace: '${legacy.mode}'`;
      throw new ConfigurationError('INVALID_CONFIG', `${where} ${legacy.was} is the old spelling of ${spelled}; the modes are ${MODES_LIST}`);
    }
    throw new ConfigurationError('INVALID_CONFIG', `${where} must be one of ${MODES_LIST}, got ${describeValue(value)}`);
  }
  return value;
}

/** One kind's modes before any target speaks: the flag, the config root, and the default under both. */
interface RunRecording {
  readonly cli: RecordingMode | undefined;
  readonly config: RecordingMode | undefined;
  readonly fallback: RecordingMode;
}

/**
 * The run's `trace` and `video` modes before any target speaks. A trace is
 * on by default locally and recorded on the first retry in CI, where a
 * trace of every attempt is the cost of a large share of the run.
 */
function runRecordings(raw: E2EConfig, cli: CliOverrides, ci: boolean): Readonly<Record<RecordingKind, RunRecording>> {
  return {
    trace: { cli: recordingMode(cli.trace, '--trace', 'trace'), config: recordingMode(raw.trace, 'trace', 'trace'), fallback: ci ? 'on-first-retry' : 'on' },
    video: { cli: recordingMode(cli.video, '--video', 'video'), config: recordingMode(raw.video, 'video', 'video'), fallback: 'off' },
  };
}

/**
 * A target's effective mode of one kind, with where it came from: the flag,
 * else the target's own, else the config root's, else the default. The
 * target's own is checked whether or not the flag wins over it, so a flag
 * never hides a config mistake.
 */
function targetRecording(run: RunRecording, own: unknown, where: string, kind: RecordingKind): ResolvedRecording {
  const target = recordingMode(own, where, kind);
  if (run.cli !== undefined) return { mode: run.cli, source: 'run' };
  if (target !== undefined) return { mode: target, source: 'target' };
  if (run.config !== undefined) return { mode: run.config, source: 'run' };
  return { mode: run.fallback, source: 'default' };
}


/** Checks one `screenshot` value: a mode, or undefined when the key is unset. */
function screenshotMode(value: unknown, where: string): ScreenshotMode | undefined {
  if (value === undefined) return undefined;
  if (!isScreenshotMode(value)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} must be one of ${SCREENSHOT_MODES.join(', ')}, got ${describeValue(value)}`);
  }
  return value;
}

/** The run's screenshot mode before any target speaks: the flag, the config root, and the default under both. */
interface RunScreenshot {
  readonly cli: ScreenshotMode | undefined;
  readonly config: ScreenshotMode | undefined;
  readonly fallback: ScreenshotMode;
}

/** The run's screenshot mode before any target speaks, from the flag and the config root. */
function runScreenshot(raw: E2EConfig, cli: CliOverrides, evidence: boolean): RunScreenshot {
  return {
    cli: screenshotMode(cli.screenshot, '--screenshot'),
    config: screenshotMode(raw.screenshot, 'screenshot'),
    // An evidence pack shows each step by its frame, so evidence asks for one per step unless someone chose otherwise.
    fallback: evidence ? 'every-step' : 'on-failure',
  };
}

const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['enabled', 'outDir', 'profile']);
const EVIDENCE_OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off']);

/**
 * Whether the run writes an evidence pack: `--no-evidence` first, then
 * `E2E_EVIDENCE` (`0`, `false`, or `off` turn it off; any other value is
 * ignored), then the config, then on.
 */
function evidenceEnabled(value: unknown, env: NodeJS.ProcessEnv, cli: CliOverrides): boolean {
  checkEvidenceShape(value);
  if (cli.evidence === false) return false;
  const fromEnv = env['E2E_EVIDENCE']?.trim().toLowerCase();
  if (fromEnv !== undefined && EVIDENCE_OFF_VALUES.has(fromEnv)) return false;
  if (value === false) return false;
  if (typeof value === 'object' && value !== null && (value as EvidenceConfig).enabled === false) return false;
  return true;
}

/** Refuses an `evidence` value that is not a boolean or `{ enabled?, outDir?, profile? }` with valid fields. */
function checkEvidenceShape(value: unknown): void {
  if (value === undefined || typeof value === 'boolean') return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigurationError('INVALID_CONFIG', `evidence must be true, false, or { enabled?, outDir?, profile? }, got ${describeValue(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_KEYS.has(key)) {
      throw new ConfigurationError('INVALID_CONFIG', `evidence has unknown key "${key}"; evidence is { enabled?, outDir?, profile? }${didYouMean(key, [...EVIDENCE_KEYS])}`);
    }
  }
  const { enabled, profile, outDir } = value as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `evidence.enabled must be a boolean, got ${describeValue(enabled)}`);
  }
  if (profile !== undefined && profile !== 'L0' && profile !== 'L1') {
    throw new ConfigurationError('INVALID_CONFIG', `evidence.profile must be 'L0' or 'L1', got ${describeValue(profile)}`);
  }
  if (outDir !== undefined && (typeof outDir !== 'string' || outDir.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `evidence.outDir must be a non-empty path relative to the project root, got ${describeValue(outDir)}`);
  }
}

/** The pack's directory and profile, for a run that writes one. */
function resolveEvidence(value: unknown, projectRoot: string, output: string, cacheDir: string): ResolvedEvidence {
  const settings = typeof value === 'object' && value !== null ? (value as EvidenceConfig) : {};
  const outDir = settings.outDir === undefined ? path.join(output, 'evidence') : path.resolve(projectRoot, settings.outDir);
  if (settings.outDir !== undefined) {
    const named = `evidence.outDir ${JSON.stringify(settings.outDir)}`;
    const refuse = (reason: string): never => {
      throw new ConfigurationError('INVALID_CONFIG', `${named} ${reason}`);
    };
    const root = realpathOfExisting(projectRoot);
    const real = realpathOfExisting(outDir);
    if (real === root || !isWithin(real, root)) refuse('must be a directory inside the project, not its root');
    // A run removes every pack in it: never a directory the cache is committed from, or one each run clears.
    const cache = realpathOfExisting(cacheDir);
    if (isWithin(real, cache)) refuse(`is the cache directory ${path.relative(root, cache)} or inside it; keep packs and the replay cache apart`);
    for (const owned of OUTPUT_OWNED_DIRS) {
      const dir = realpathOfExisting(path.join(output, owned));
      if (isWithin(real, dir)) refuse(`is inside ${path.relative(root, dir)}, which every run clears; name a directory of its own`);
    }
    const existing = nearestExisting(outDir);
    if (existing !== undefined && !statSync(existing).isDirectory()) refuse('is a file, or under one; name a directory');
  }
  return { outDir, profile: settings.profile ?? 'L1' };
}

/**
 * A target's effective screenshot mode: the flag, else the target's own,
 * else the config root's, else the default. The target's own is checked
 * whether or not the flag wins over it, so a flag never hides a config mistake.
 */
function targetScreenshot(run: RunScreenshot, own: unknown, where: string): ScreenshotMode {
  const target = screenshotMode(own, where);
  return run.cli ?? target ?? run.config ?? run.fallback;
}

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
      if (!isBuiltinReporter(reporter)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown reporter "${reporter}"; reporters are ${BUILTIN_REPORTER_LIST}${didYouMean(reporter, BUILTIN_REPORTERS)}`,
        );
      }
      ids.push(reporter);
    } else if (isReporter(reporter)) {
      customReporters.push(reporter);
    } else {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `a reporter is a built-in id (${BUILTIN_REPORTERS.join(', ')}) or an object with a name and an onEvent or onRunFinished method`,
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
    typeof (value as { put?: unknown }).put === 'function' &&
    ['undefined', 'function'].includes(typeof (value as { putLink?: unknown }).putLink)
  );
}

/** Structural store check, mirroring how executors and models are detected. */
function isCacheStore(value: unknown): value is CacheStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['writable'] === 'boolean' &&
    typeof candidate['read'] === 'function' &&
    typeof candidate['write'] === 'function'
  );
}


/**
 * The `tests` globs, checked and compiled when the config resolves. A wrong
 * type used to be a raw TypeError reported as a test failure (at config load
 * for `tests: 5`, at collection for `tests: [1]`), and a malformed glob was
 * `INVALID_GLOB` only once a run or `e2e list` collected, so `explore`,
 * `mcp`, and `cache` accepted a config no run could use.
 */
function normalizeTests(tests: unknown, projectRoot: string): readonly string[] {
  const list = tests === undefined ? ['tests/**/*.e2e.ts'] : typeof tests === 'string' ? [tests] : tests;
  if (!Array.isArray(list)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `tests must be a glob or a list of globs relative to the project root, got ${describeValue(list)}`,
    );
  }
  if (list.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'tests must not be empty');
  }
  for (const glob of list) {
    if (typeof glob !== 'string' || glob === '') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `tests must be a glob or a list of globs relative to the project root, got ${describeValue(glob)} in the list`,
      );
    }
  }
  if (compileGlobList(list).include.length === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `tests has only "!" exclusions, which select nothing; add a glob that selects files, such as ["tests/**/*.e2e.ts", ${list.map((glob) => JSON.stringify(glob)).join(', ')}]`,
    );
  }
  for (const entry of list as readonly string[]) rejectDirectoryEntry(entry, projectRoot);
  return [...new Set(list)];
}

/**
 * Refuses a `tests` entry with no wildcard that names an existing directory,
 * with the `INVALID_GLOB` a trailing `/` gets. A glob names files, so `tests/wip` matches a file called `wip` and nothing
 * under the directory: as an exclusion it would take out nothing, and as an
 * inclusion select nothing, each without a word.
 */
function rejectDirectoryEntry(entry: string, projectRoot: string): void {
  const excluding = entry.startsWith('!');
  const glob = compileGlob(excluding ? entry.slice(1) : entry);
  const names = literalPrefix(glob);
  if (names.length !== glob.segments.length) return;
  if (statSync(path.join(projectRoot, ...names), { throwIfNoEntry: false })?.isDirectory() !== true) return;
  const dir = names.join('/');
  throw new ConfigurationError(
    'INVALID_GLOB',
    excluding
      ? `tests entry ${JSON.stringify(entry)} names a directory, and a glob names files, so it excludes nothing; write "!${dir}/**" to exclude everything under it`
      : `tests entry ${JSON.stringify(entry)} names a directory, and a glob names files, so it selects nothing; write "${dir}/**/*.e2e.ts" to select the test files under it`,
  );
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

/**
 * Credentials and secrets are separate namespaces, resolved side by side,
 * and joined once into `allSecrets`, the map `typeSecret`, the ledger, and
 * the trace key on: a credential's password joins as `<credential>.password`.
 * A credential and a secret may share a name; only a secret named exactly
 * like a password handle collides.
 */
function resolveSecrets(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
): Pick<ResolvedConfig, 'credentials' | 'secrets' | 'allSecrets'> {
  const credentials = new Map<string, ResolvedCredential>();
  const secrets = new Map<string, ResolvedSecret>();
  const allSecrets = new Map<string, ResolvedSecret>();
  checkEnvNameCollisions('E2E_USER', 'credentials', Object.keys(raw.credentials ?? {}));
  checkEnvNameCollisions('E2E_SECRET', 'secrets', Object.keys(raw.secrets ?? {}));
  for (const [name, credential] of Object.entries(raw.credentials ?? {})) {
    const prefix = envName('E2E_USER', name);
    const username = env[`${prefix}_USERNAME`] ?? credential.username;
    // An env override always wins, including over a provider: the operator
    // rotating a credential must not need to know how it was configured.
    const password = env[`${prefix}_PASSWORD`] ?? credential.password;
    if (!isSecretValue(password)) {
      throw new ConfigurationError('INVALID_CONFIG', `credential "${name}" password ${secretValueProblem(password)}`);
    }
    const secret: ResolvedSecret = { name: credentialSecretName(name), purpose: 'password', value: password };
    credentials.set(name, { name, username, password: secret });
    allSecrets.set(secret.name, secret);
  }
  for (const [name, entry] of Object.entries(raw.secrets ?? {})) {
    const owner = [...credentials.values()].find((credential) => credential.password.name === name);
    if (owner !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `secret "${name}" has the name of credential "${owner.name}"'s password handle; rename the secret`,
      );
    }
    const value = env[envName('E2E_SECRET', name)] ?? entry;
    if (!isSecretValue(value)) {
      throw new ConfigurationError('INVALID_CONFIG', `secret "${name}" ${secretValueProblem(value)}`);
    }
    const secret: ResolvedSecret = { name, purpose: 'generic-secret', value };
    secrets.set(name, secret);
    allSecrets.set(name, secret);
  }
  return { credentials, secrets, allSecrets };
}

/**
 * Two entries of one namespace whose names map to the same override variable
 * (`api-key` and `api_key` both read `E2E_SECRET_API_KEY`) would both take one
 * rotated value, so the config load refuses them, whether or not the variable
 * is set. The message names the entries and the variable, never a value.
 */
function checkEnvNameCollisions(prefix: 'E2E_USER' | 'E2E_SECRET', namespace: string, names: readonly string[]): void {
  const byEnvName = new Map<string, string[]>();
  for (const name of names) {
    const variable = envName(prefix, name);
    byEnvName.set(variable, [...(byEnvName.get(variable) ?? []), name]);
  }
  for (const [variable, group] of byEnvName) {
    if (group.length < 2) continue;
    const quoted = group.map((name) => `"${name}"`);
    const entries = `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)!}`;
    const variables = prefix === 'E2E_USER'
      ? `the override variables ${variable}_USERNAME and ${variable}_PASSWORD`
      : `the override variable ${variable}`;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${namespace} ${entries} share ${variables}, so one value set there would replace all of them; rename all but one`,
    );
  }
}

/**
 * Every secret an engine's options hold (a `secrets.get()` the config
 * evaluated before any run existed) names a configured secret, so a typo
 * fails the config load instead of the first attempt that resolves it.
 */
function checkEngineSecrets(
  targets: readonly ResolvedTarget[],
  secrets: ResolvedConfig['secrets'],
  credentials: ResolvedConfig['credentials'],
): void {
  for (const target of targets) {
    for (const secret of target.engine?.secrets ?? []) {
      if (secrets.has(secret.name)) continue;
      const credential = credentialNamed(secret.name, credentials);
      const hint = credential === undefined
        ? didYouMean(secret.name, [...secrets.keys()])
        : `; credential "${credential.name}" is not a secrets entry, and an engine option takes one: declare the value under config.secrets`;
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${target.name}" engine ${target.engine!.name} uses secrets.get(${JSON.stringify(secret.name)}), which is not configured; add it to config.secrets${hint}`,
      );
    }
  }
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
 * names none (the built-in agent with no model, which fails when the `agent`
 * fixture is first acquired). Each entry resolves on its own, from the
 * built-in defaults.
 * The run's agents are `default` alone unless `--agent` named others; an
 * unknown name is a config error before anything starts.
 */
function resolveAgents(
  raw: E2EConfig['agents'],
  selected: readonly string[] | undefined,
): { agents: ReadonlyMap<string, ResolvedAgentConfig>; agentNames: readonly string[]; agent: ResolvedAgentConfig } {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw) || isStepExecutor(raw))) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agents must be an object of agents by name: agents: { default: { model } }',
    );
  }
  const agents = new Map<string, ResolvedAgentConfig>();
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid agent name ${JSON.stringify(name)}: names are ASCII letters, numbers, "_", "-", or ".", and cannot be only dots`,
      );
    }
    agents.set(name, resolveAgentConfig(value, `agents.${name}`));
  }
  if (!agents.has(DEFAULT_AGENT_NAME)) {
    agents.set(DEFAULT_AGENT_NAME, resolveAgentConfig(undefined));
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

function computeConfigDigest(
  raw: E2EConfig,
  projectId: string,
  targets: readonly ResolvedTarget[],
): string {
  // Only plain data is JSON-cloned. Every live value is reduced to its
  // identity before any clone sees it, since its object graph may not
  // serialize at all (a recursive tool schema, a client inside a store) and
  // a model instance carries provider settings, possibly credentials, that
  // must never be digested: agents digest their tools by name, an executor
  // by its name, version, and models, and a model anywhere by its identity;
  // `cache.store` digests as whether it is writable; targets, credentials,
  // and secrets are reduced below.
  //
  // `artifacts` holds only a host store, a live value, so it never enters the
  // digest. Nor does `output`, where results land, nor `trace`, `video`, and `screenshot`, at the top or on a target: recording
  // a run must never invalidate the replays it would otherwise make. A
  // reporter object changes nothing about what a run records, so it never
  // enters the digest either; the built-in ids digest as they always have,
  // so adding a reporter to a config leaves its cache valid.
  // `failOnSkippedFailure` decides only the exit code, never what runs.
  // `targets` digest by declaration below and never enter the clone: an
  // engine holds `secrets.get()` handles, which refuse to serialize.
  const {
    failOnSkippedFailure: _failOnSkippedFailure,
    artifacts: _artifacts,
    output: _output,
    trace: _trace,
    video: _video,
    screenshot: _screenshot,
    evidence: _evidence,
    targets: _targets,
    credentials: _credentials,
    secrets: _secrets,
    agents,
    cache,
    reporters,
    ...plain
  } = raw;
  const sanitized: Record<string, unknown> = {
    ...(structuredCloneJsonSafe(plain) as Record<string, unknown>),
    ...(reporters === undefined
      ? {}
      : { reporters: Array.isArray(reporters) ? reporters.filter((reporter) => typeof reporter === 'string') : structuredCloneJsonSafe(reporters) }),
    ...(agents === undefined ? {} : { agents: digestAgents(agents) }),
    ...(cache === undefined ? {} : { cache: digestCache(cache) }),
    projectId,
  };
  if (raw.credentials !== undefined) {
    sanitized['credentials'] = Object.fromEntries(
      Object.entries(raw.credentials).map(([name, credential]) => [
        name,
        { username: credential.username, password: { secretName: name } },
      ]),
    );
  }
  if (raw.secrets !== undefined) {
    sanitized['secrets'] = Object.fromEntries(
      Object.keys(raw.secrets).map((name) => [name, { secretName: name }]),
    );
  }
  // Targets enter as resolved: see `digestTargets`.
  sanitized['targets'] = digestTargets(targets);
  return canonicalDigest(sanitized);
}

/**
 * The agents as the digest records them. Each entry passed `resolveAgents`,
 * so it is a plain options object: its plain options are cloned, its tools
 * named, and its executor reduced to what identifies it.
 */
function digestAgents(agents: NonNullable<E2EConfig['agents']>): unknown {
  return Object.fromEntries(
    Object.entries(agents).map(([name, entry]) => {
      const { tools, executor, ...options } = entry ?? {};
      return [
        name,
        {
          ...(structuredCloneJsonSafe(options) as Record<string, unknown>),
          ...(tools === undefined ? {} : { tools: Object.keys(tools).toSorted() }),
          ...(executor === undefined
            ? {}
            : {
                executor: {
                  name: executor.name,
                  ...(executor.version === undefined ? {} : { version: executor.version }),
                  ...(executor.cache === undefined ? {} : { cache: executor.cache }),
                  ...(executor.model === undefined ? {} : { model: modelIdentity(executor.model) }),
                  ...(executor.judge === undefined ? {} : { judge: modelIdentity(executor.judge) }),
                },
              }),
        },
      ];
    }),
  );
}

/** `cache` as the digest records it: a mode string as is, an options object with its store reduced to whether it writes. */
function digestCache(cache: NonNullable<E2EConfig['cache']>): unknown {
  if (typeof cache !== 'object' || cache === null) return cache;
  const { store, ...options } = cache;
  return { ...options, ...(store === undefined ? {} : { store: { writable: store.writable } }) };
}

/**
 * A JSON round trip that drops functions and reduces every AI SDK model
 * instance, at any depth, to its provider/id identity. The digest reads the
 * same whether a model sits in `agents.<name>.model`, in `judge`, or inside
 * a custom executor.
 */
function structuredCloneJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'function') return undefined;
      return isModelInstance(item) ? modelIdentity(item) : item;
    }) ?? 'null',
  );
}
