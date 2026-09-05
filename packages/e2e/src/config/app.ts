/** App, command, and service resolution (spec 05-config.md). */

import path from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import { isImplicitTestHost, normalizeBaseUrl, type NormalizedBaseUrl } from '../internal/urls.ts';
import type { AppConfig, CommandConfig, E2EConfig, ServiceConfig } from '../types.ts';
import { httpUrl, positiveInt } from './validate.ts';

/**
 * How a spawned process counts as ready: a URL that answers, or the process
 * itself exiting with code 0 (a migration, `docker compose up --wait`).
 */
export type Readiness = { readonly readyUrl: string } | { readonly waitForExit: true };

/** A command the runner spawns, named for error messages. */
export interface ResolvedCommand {
  readonly label: string;
  readonly command: CommandConfig;
}

/** One `app.services` entry with its readiness contract already decided. */
export interface ResolvedService extends ResolvedCommand {
  readonly readiness: Readiness;
  readonly teardown: ResolvedCommand | undefined;
}

export interface ResolvedApp {
  /** False when no app URL was configured and `base` is a synthetic loopback placeholder. */
  readonly configured: boolean;
  readonly base: NormalizedBaseUrl;
  readonly readyUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: 'test' | 'staging' | 'production';
  readonly command: CommandConfig | undefined;
  /** Dependency processes started in order before `command` and torn down in reverse. */
  readonly services: readonly ResolvedService[];
  /** Stable logical app identity; overrides the origin for cache/session keying. */
  readonly identity: string | undefined;
}

const APP_KEYS = new Set([
  'url',
  'command',
  'readyUrl',
  'services',
  'allowedOrigins',
  'environment',
  'identity',
]);

/** App keys that make sense without an app URL; every other key needs one. */
const URL_FREE_APP_KEYS = new Set(['url', 'command', 'services']);

export function resolveApp(raw: E2EConfig, env: NodeJS.ProcessEnv): ResolvedApp {
  if (raw.app !== undefined) {
    for (const key of Object.keys(raw.app)) {
      if (!APP_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown app config key "${key}"`);
      }
    }
  }
  const services = resolveServices(raw.app?.services);
  const rawUrl = raw.app?.url ?? env['APP_URL'];
  if (rawUrl === undefined || rawUrl === '') {
    // Not every surface has an app URL to point at (a device, a desktop
    // shell): a synthetic loopback base keeps navigation resolution and
    // identity digests defined, and `app.open()` fails loud with
    // APP_URL_REQUIRED the moment a test actually needs one. A configured
    // app command without a URL is still a mistake worth failing early on.
    const orphaned = Object.keys(raw.app ?? {}).filter((key) => !URL_FREE_APP_KEYS.has(key));
    if (orphaned.length > 0) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `app.${orphaned[0]} requires app.url: set app.url in e2e.config.ts or the APP_URL environment variable`,
      );
    }
    if (raw.app?.command === undefined) {
      return {
        configured: false,
        base: normalizeBaseUrl('http://127.0.0.1:1'),
        readyUrl: 'http://127.0.0.1:1/',
        allowedOrigins: [],
        environment: 'test',
        command: undefined,
        services,
        identity: undefined,
      };
    }
    throw new ConfigurationError(
      'APP_URL_REQUIRED',
      'an app URL is required alongside app.command: set app.url in e2e.config.ts or the APP_URL environment variable',
    );
  }
  const base = normalizeBaseUrl(rawUrl);
  const baseHost = new URL(base.href).hostname;

  // The environment is a label for the report and the cache/session identity
  // digest, not a gate: a loopback, `.localhost`, or `.test` host is `test`,
  // any other host is `production` unless the config says otherwise.
  const environment = raw.app?.environment ?? (isImplicitTestHost(baseHost) ? 'test' : 'production');
  if (!['test', 'staging', 'production'].includes(environment)) {
    throw new ConfigurationError('INVALID_CONFIG', `invalid app.environment "${environment}"`);
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
  if (command !== undefined) validateCommand(command, 'app.command');

  const identity = raw.app?.identity;
  if (identity !== undefined && (typeof identity !== 'string' || identity.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'app.identity must be a non-empty string');
  }

  return {
    configured: true,
    base,
    readyUrl: httpUrl(raw.app?.readyUrl, 'app.readyUrl') ?? base.href,
    allowedOrigins,
    environment,
    command,
    services,
    identity,
  };
}

/**
 * The shape every spawned command shares: a non-empty executable and, when
 * set, positive integer timeouts. A NaN or infinite budget would otherwise
 * make the readiness loop spin without a deadline.
 */
function validateCommand(command: CommandConfig, label: string): void {
  if (typeof command !== 'object' || command === null) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be an object`);
  }
  if (typeof command.executable !== 'string' || command.executable.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.executable is required`);
  }
  positiveInt(command.startupTimeout, `${label}.startupTimeout`);
  positiveInt(command.shutdownTimeout, `${label}.shutdownTimeout`);
}

/** The longest `name` a service may carry; a label, not a description. */
const SERVICE_NAME_MAX_LENGTH = 64;

/**
 * The name a service goes by in errors, reporter output, and the report: the
 * explicit `name`, trimmed, or the executable's base name (`docker`, `pnpm`,
 * and for a shell wrapper just `sh`, which is when an explicit name earns its
 * keep). Explicit names must be unique so two failures never read alike.
 */
function serviceName(service: ServiceConfig, position: string, taken: Set<string>): string {
  if (service.name === undefined) return path.basename(service.executable);
  const name = typeof service.name === 'string' ? service.name.trim() : '';
  if (name.length === 0 || name.length > SERVICE_NAME_MAX_LENGTH) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${position}.name must be a non-empty string of at most ${SERVICE_NAME_MAX_LENGTH} characters`,
    );
  }
  if (taken.has(name)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${position}.name "${name}" is already used by another service; service names must be unique`,
    );
  }
  taken.add(name);
  return name;
}

/**
 * Resolves `app.services`: every service is a command with exactly one
 * readiness contract (`readyUrl` or `waitForExit`), and a `teardown` is a
 * command of its own. The service fields that only steer the runner
 * (`name`, `readyUrl`, `waitForExit`, `teardown`) are lifted out of the command.
 */
export function resolveServices(raw: AppConfig['services']): readonly ResolvedService[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', 'app.services must be an array');
  }
  const names = new Set<string>();
  return raw.map((service: ServiceConfig, index): ResolvedService => {
    const position = `app.services[${index}]`;
    validateCommand(service, position);
    const { name: _name, readyUrl: rawReadyUrl, waitForExit, teardown, ...command } = service;
    const readyUrl = httpUrl(rawReadyUrl, `${position}.readyUrl`);
    if ((readyUrl !== undefined) === (waitForExit === true)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${position} needs exactly one readiness contract: set readyUrl or waitForExit: true`,
      );
    }
    const readiness: Readiness = readyUrl === undefined ? { waitForExit: true } : { readyUrl };
    const label = `service "${serviceName(service, position, names)}"`;
    if (teardown !== undefined) validateCommand(teardown, `${position}.teardown`);
    return {
      label,
      command,
      readiness,
      teardown: teardown === undefined ? undefined : { label: `${label} teardown`, command: teardown },
    };
  });
}

/** A command's env as it enters the config digest: values reduced to their names (13-reporting.md). */
interface DigestedEnv {
  readonly env?: Readonly<Record<string, { envName: string }>>;
}

function digestCommand<T extends CommandConfig>(command: T): Omit<T, 'env'> & DigestedEnv {
  const { env, ...rest } = command;
  if (env === undefined) return rest;
  return { ...rest, env: Object.fromEntries(Object.keys(env).map((key) => [key, { envName: key }])) };
}

/**
 * The digest view of `app`: `app.command.env`, every service's env, and every
 * service teardown's env become names, so no environment value contributes to
 * the digest. Live values never appear under `app`, so nothing else changes.
 */
export function digestApp(app: AppConfig): Record<string, unknown> {
  return {
    ...app,
    ...(app.command === undefined ? {} : { command: digestCommand(app.command) }),
    ...(app.services === undefined
      ? {}
      : {
          services: app.services.map(({ teardown, ...service }) => ({
            ...digestCommand(service),
            ...(teardown === undefined ? {} : { teardown: digestCommand(teardown) }),
          })),
        }),
  };
}
