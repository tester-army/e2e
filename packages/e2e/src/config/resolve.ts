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
import type { CommandConfig, E2EConfig, MobileTarget, Target, WebTarget } from '../types.ts';
import {
  isModelInstance,
  resolveAgentConfig,
  resolveLimits,
  type ResolvedAgentConfig,
  type ResolvedLimits,
} from './agent.ts';

export type { ResolvedAgentConfig, ResolvedLimits, ResolvedModel } from './agent.ts';

interface ResolvedTargetBase {
  readonly name: string;
  readonly index: number;
  /** Well-known driver id resolved on demand, or an imported branded handle. */
  readonly driver: WellKnownDriverId | Driver;
  /** Wire-shaped target passed to the driver at launch. */
  readonly driverTarget: Target;
}

export interface ResolvedWebTarget extends ResolvedTargetBase {
  readonly platform: 'web';
  readonly browser: 'chromium' | 'firefox' | 'webkit';
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
}

/**
 * A `mobile-0.1` target. There is no bundled mobile driver, so the driver is
 * always an imported handle. `device` and `os` are left to the driver to
 * resolve when absent, and it reports what it selected as target provenance.
 */
export interface ResolvedMobileTarget extends ResolvedTargetBase {
  readonly platform: 'ios' | 'android';
  readonly driver: Driver;
  /** Installed application identity, or a build artifact path. */
  readonly app: string;
  readonly device: string | undefined;
  readonly os: string | undefined;
}

export type ResolvedTarget = ResolvedWebTarget | ResolvedMobileTarget;

/** Narrows a resolved target to the mobile family. */
export function isMobileTarget(target: ResolvedTarget): target is ResolvedMobileTarget {
  return target.platform !== 'web';
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
    /**
     * Absent for a config whose targets are all mobile. `mobile-0.1` has no
     * base URL, so requiring one would force an unused placeholder.
     */
    readonly base: NormalizedBaseUrl | undefined;
    readonly readyUrl: string | undefined;
    readonly allowedOrigins: readonly string[];
    readonly environment: 'test' | 'staging' | 'production';
    readonly allowProduction: boolean;
    readonly command: CommandConfig | undefined;
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
  readonly reporters: readonly ('list' | 'json' | 'html')[];
  readonly testIdAttribute: string;
  readonly agent: ResolvedAgentConfig;
  readonly limits: ResolvedLimits;
  readonly credentials: ReadonlyMap<string, ResolvedCredential>;
  readonly configDigest: string;
}

export interface CliOverrides {
  retries?: number;
  workers?: number;
  reporters?: readonly ('list' | 'json' | 'html')[];
  headed?: boolean;
  artifactsDir?: string;
  /** `--no-agent-cache` forces cache mode off. */
  agentCache?: 'off';
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
  'limits',
  'credentials',
]);

const APP_KEYS = new Set([
  'url',
  'command',
  'readyUrl',
  'allowedOrigins',
  'environment',
  'allowProduction',
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

  // Targets first: whether an app URL is required depends on whether any
  // selected target is a web target.
  const targets = resolveTargets(raw);
  const app = resolveApp(raw, env, targets.some((target) => !isMobileTarget(target)));
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
  const reporters = cli.reporters ?? raw.reporters ?? (['list', 'html'] as const);
  for (const reporter of reporters) {
    if (!['list', 'json', 'html'].includes(reporter)) {
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
  const agent = resolveAgentConfig(raw, env, ci, cli.agentCache, baseLimits);
  const limits: ResolvedLimits = { ...baseLimits, maxObservationBytes: agent.maxObservationBytes };

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
    limits,
    credentials,
    configDigest: computeConfigDigest(raw, projectId),
  };
  return resolved;
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

function resolveApp(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
  baseUrlRequired: boolean,
): ResolvedConfig['app'] {
  if (raw.app !== undefined) {
    for (const key of Object.keys(raw.app)) {
      if (!APP_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown app config key "${key}"`);
      }
    }
  }
  const rawUrl = raw.app?.url ?? env['APP_URL'];
  if (rawUrl === undefined || rawUrl === '') {
    if (baseUrlRequired) {
      throw new ConfigurationError(
        'APP_URL_REQUIRED',
        'an app URL is required: set app.url in e2e.config.ts or the APP_URL environment variable',
      );
    }
  }
  const base =
    rawUrl === undefined || rawUrl === '' ? undefined : normalizeBaseUrl(rawUrl);

  let environment = raw.app?.environment;
  if (environment === undefined) {
    // Without a base URL there is no host to infer an environment from, so a
    // mobile-only config defaults to test rather than demanding a declaration.
    const baseHost = base === undefined ? undefined : new URL(base.href).hostname;
    if (baseHost !== undefined && !isImplicitTestHost(baseHost)) {
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

  const allowedOrigins = raw.app?.allowedOrigins ?? (base === undefined ? [] : [base.origin]);
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
    // Readiness is polled over HTTP. Without a base URL to derive it from, the
    // config must say where to poll rather than start a process blind.
    if (base === undefined && raw.app?.readyUrl === undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'app.command requires app.readyUrl when no app URL is configured',
      );
    }
  }

  return {
    base,
    readyUrl: raw.app?.readyUrl ?? base?.href,
    allowedOrigins,
    environment,
    allowProduction,
    command,
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
    if (target.platform === 'ios' || target.platform === 'android') {
      return resolveMobileTarget(target as MobileTarget, index);
    }
    if (target.platform !== 'web') {
      throw new ConfigurationError(
        'PLATFORM_UNSUPPORTED',
        `target "${target.name}" requests platform "${target.platform}"; this runner executes web, ios, and android targets`,
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

/**
 * Resolves one `mobile-0.1` target. There is no bundled mobile driver, so
 * `driver` must be an imported `defineDriver` handle that declares the
 * requested platform.
 */
function resolveMobileTarget(target: MobileTarget, index: number): ResolvedMobileTarget {
  const platform = target.platform;
  if (!isDriverHandle(target.driver)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${target.name}" requires a defineDriver handle; there is no bundled "${platform}" driver`,
    );
  }
  if (!target.driver.platforms.includes(platform)) {
    throw new ConfigurationError(
      'PLATFORM_UNSUPPORTED',
      `target "${target.name}" requests platform "${platform}" but driver ${target.driver.id} declares ${target.driver.platforms.join(', ')}`,
    );
  }
  if (typeof target.app !== 'string' || target.app.length === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${target.name}" requires app as a bundle identifier, package name, or build artifact path`,
    );
  }
  for (const field of ['device', 'os'] as const) {
    const value = target[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${target.name}" ${field} must be a nonempty string when present`,
      );
    }
  }
  return {
    name: target.name,
    index,
    platform,
    driver: target.driver,
    app: target.app,
    device: target.device,
    os: target.os,
    driverTarget: {
      name: target.name,
      platform,
      driver: target.driver,
      app: target.app,
      ...(target.device !== undefined ? { device: target.device } : {}),
      ...(target.os !== undefined ? { os: target.os } : {}),
    },
  };
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
  const rawModel = raw.agent?.model;
  const forClone = isModelInstance(rawModel)
    ? {
        ...raw,
        agent: {
          ...raw.agent,
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
