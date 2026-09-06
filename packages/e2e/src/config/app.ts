/**
 * Per-target app resolution (spec 05-config.md): what a backend declares
 * about the app it drives, validated where an error can name the target.
 */

import path from 'node:path';
import type { BackendAppDeclaration, BackendHandle } from '../backend/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { isImplicitTestHost, normalizeBaseUrl, type NormalizedBaseUrl } from '../internal/urls.ts';
import type { CommandConfig, ServiceConfig } from '../types.ts';
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

/** One declared service with its readiness contract already decided. */
export interface ResolvedService extends ResolvedCommand {
  /** The explicit `name`, trimmed; undefined when the label fell back to the executable. */
  readonly name: string | undefined;
  readonly readiness: Readiness;
  readonly teardown: ResolvedCommand | undefined;
}

/**
 * The app one target drives, as the harness resolved the backend's `app`
 * declaration. Navigation policy, cache and session identity, the report's
 * target record, and the app processes all read from here; a target without a
 * backend, or whose backend declares nothing, gets the empty resolution.
 */
export interface ResolvedApp {
  /** Normalized base URL; undefined for a surface without addressable locations. */
  readonly base: NormalizedBaseUrl | undefined;
  readonly allowedOrigins: readonly string[];
  readonly environment: 'test' | 'staging' | 'production';
  /**
   * Stable identity keying cache and session entries: the declared identity,
   * else the base URL's origin and path. Undefined when the backend declares
   * neither, so entries key on the target and environment alone.
   */
  readonly identity: string | undefined;
  readonly command: CommandConfig | undefined;
  /** Readiness probe for `command`; defined whenever `command` is. */
  readonly readyUrl: string | undefined;
  /** Dependency processes started in order before any app command and torn down in reverse. */
  readonly services: readonly ResolvedService[];
}

const ENVIRONMENTS = new Set(['test', 'staging', 'production']);

/**
 * Resolves one target's app from its backend's `app` declaration. Every fact
 * is optional: a URL normalizes like any base URL, origins must be serialized
 * origins, a command needs something to poll, services need one readiness
 * contract each, and the identity defaults to where the app is served when
 * the backend gives none.
 */
export function resolveTargetApp(targetName: string, backend: BackendHandle | undefined): ResolvedApp {
  const declared: BackendAppDeclaration = backend?.app ?? {};
  const where = `target "${targetName}" backend ${backend?.name ?? 'none'}`;
  const base = declared.url === undefined ? undefined : normalizeBaseUrl(declared.url);

  const environment =
    declared.environment ??
    (base !== undefined && !isImplicitTestHost(new URL(base.href).hostname) ? 'production' : 'test');
  if (!ENVIRONMENTS.has(environment)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares invalid app.environment "${String(environment)}"`,
    );
  }

  const allowedOrigins = declared.allowedOrigins ?? (base === undefined ? [] : [base.origin]);
  if (!Array.isArray(allowedOrigins)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} app.allowedOrigins must be an array`);
  }
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigurationError('INVALID_CONFIG', `${where} declares an invalid allowed origin: ${origin}`);
    }
    if (parsed.origin !== origin) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} allowed origin must be a serialized origin, got ${origin} (expected ${parsed.origin})`,
      );
    }
  }

  const identity = declared.identity;
  if (identity !== undefined && (typeof identity !== 'string' || identity.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} app.identity must be a non-empty string`);
  }

  const command = declared.command;
  if (command !== undefined) validateCommand(command, `${where} app.command`);
  const readyUrl = httpUrl(declared.readyUrl, `${where} app.readyUrl`) ?? base?.href;
  if (command !== undefined && readyUrl === undefined) {
    throw new ConfigurationError(
      'APP_URL_REQUIRED',
      `${where} declares app.command without a URL to poll: declare url or readyUrl beside it`,
    );
  }

  return {
    base,
    allowedOrigins,
    environment,
    identity: identity ?? (base === undefined ? undefined : `${base.origin}${base.basePath}`),
    command,
    readyUrl: command === undefined ? undefined : readyUrl,
    services: resolveServices(declared.services, `${where} app.services`),
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
 * Resolves a declaration's `services`: every service is a command with exactly
 * one readiness contract (`readyUrl` or `waitForExit`), and a `teardown` is a
 * command of its own. The service fields that only steer the runner
 * (`name`, `readyUrl`, `waitForExit`, `teardown`) are lifted out of the command.
 * `prefix` names the declaring target in errors, so a failing service is
 * traceable to the backend that declared it.
 */
export function resolveServices(
  raw: BackendAppDeclaration['services'],
  prefix = 'app.services',
): readonly ResolvedService[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', `${prefix} must be an array`);
  }
  const names = new Set<string>();
  return raw.map((service: ServiceConfig, index): ResolvedService => {
    const position = `${prefix}[${index}]`;
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
    const name = serviceName(service, position, names);
    const label = `service "${name}"`;
    if (teardown !== undefined) validateCommand(teardown, `${position}.teardown`);
    return {
      label,
      name: service.name === undefined ? undefined : name,
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
 * The declarative part of a backend's `app` manifest as it enters the config
 * digest: hooks stripped, and every `command.env`, service env, and service
 * teardown env value replaced by `{ envName: key }`, so no environment value
 * contributes to the digest.
 */
export function digestAppDeclaration(app: BackendAppDeclaration) {
  const { url, allowedOrigins, environment, identity, command, readyUrl, services } = app;
  return obj({
    url,
    allowedOrigins,
    environment,
    identity,
    readyUrl,
    command: command === undefined ? undefined : digestCommand(command),
    services: services?.map(({ teardown, ...service }) =>
      obj({
        ...digestCommand(service),
        teardown: teardown === undefined ? undefined : digestCommand(teardown),
      }),
    ),
  });
}
