/**
 * Per-target app resolution: what an engine declares
 * about the app it drives, validated where an error can name the target.
 */

import path from 'node:path';
import type { EngineAppDeclaration, EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { insideProjectRoot } from '../internal/paths.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isSecret } from '../secrets.ts';
import {
  isImplicitTestHost,
  normalizeBaseUrl,
  portOf,
  requestsFreePort,
  siteOf,
  withPort,
  type NormalizedBaseUrl,
} from '../internal/urls.ts';
import type { CommandConfig, ServiceConfig } from '../types.ts';
import { describeValue, httpUrl, positiveInt } from './validate.ts';

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
 * A declared URL with port 0 asks the run for a free port on its loopback
 * host. `port` is the one the run assigned, undefined until it did: a config
 * resolved outside a run (`e2e list`, the cache CLI) keeps the `:0` URL.
 */
export interface PortRequest {
  /** The hostname to bind, as the URL spelled it. */
  readonly host: string;
  readonly port: number | undefined;
}

/**
 * The app one target drives, as the harness resolved the engine's `app`
 * declaration. Navigation policy, cache and session identity, the report's
 * target record, and the app processes all read from here; a target without a
 * engine, or whose engine declares nothing, gets the empty resolution.
 */
export interface ResolvedApp {
  /** Normalized base URL; undefined for a surface without addressable locations. */
  readonly base: NormalizedBaseUrl | undefined;
  /** The free-port request the declared URL made; undefined when it names a port or there is no URL. */
  readonly portRequest: PortRequest | undefined;
  /**
   * The site of the base URL, as `siteOf` reads it: where configured
   * headers go and whose child frames observations read. Undefined without
   * a URL, which is no policy at all.
   */
  readonly site: string | undefined;
  readonly environment: 'test' | 'staging' | 'production';
  /**
   * Stable identity keying cache and session entries: the declared identity,
   * else the base URL's origin and path. Undefined when the engine declares
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
 * Resolves one target's app from its engine's `app` declaration. Every fact
 * is optional: a URL normalizes like any base URL, a command needs something
 * to poll, services need one readiness contract each, and the identity
 * defaults to where the app is served when the engine gives none.
 * `projectRoot` anchors every command's `log` path. `port` is the free port
 * the run assigned to a URL declared with port 0: it replaces the 0 in the
 * base URL and the default readiness probe. The default identity keeps the
 * declared `:0`, so cache and session entries survive the port changing
 * every run. `{port}` in the command, the services, and their
 * readiness URLs expands to the port the app is served on, assigned or fixed.
 */
export function resolveTargetApp(
  targetName: string,
  engine: EngineHandle | undefined,
  projectRoot: string,
  port?: number,
): ResolvedApp {
  const declared: EngineAppDeclaration = engine?.app ?? {};
  const where = `target "${targetName}" engine ${engine?.name ?? 'none'}`;
  const declaredBase = declared.url === undefined ? undefined : normalizeBaseUrl(declared.url);
  const portRequest = declaredBase === undefined ? undefined : freePortRequest(declaredBase, port);
  const base =
    declaredBase !== undefined && portRequest?.port !== undefined ? withPort(declaredBase, portRequest.port) : declaredBase;
  // What `{port}` expands to. While a requested port is unassigned this is 0,
  // the port the base URL still carries, so the config resolves and validates
  // the same way before and after assignment.
  const appPort = base === undefined ? undefined : portOf(base);
  const expand = (value: string, label: string): string => expandPort(value, appPort, label);

  const environment =
    declared.environment ??
    (base !== undefined && !isImplicitTestHost(new URL(base.href).hostname) ? 'production' : 'test');
  if (!ENVIRONMENTS.has(environment)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares invalid app.environment "${String(environment)}"`,
    );
  }

  const identity = declared.identity;
  if (identity !== undefined && (typeof identity !== 'string' || identity.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} app.identity must be a non-empty string`);
  }

  const command =
    declared.command === undefined ? undefined : expandCommandPort(declared.command, `${where} app.command`, expand);
  if (command !== undefined) validateCommand(command, `${where} app.command`, projectRoot);
  const readyUrl =
    httpUrl(
      declared.readyUrl === undefined ? undefined : expand(declared.readyUrl, `${where} app.readyUrl`),
      `${where} app.readyUrl`,
    ) ?? base?.href;
  if (command !== undefined && readyUrl === undefined) {
    throw new ConfigurationError(
      'APP_URL_REQUIRED',
      `${where} declares app.command without a URL to poll: declare url or readyUrl beside it`,
    );
  }

  return {
    base,
    portRequest,
    site: base === undefined ? undefined : siteOf(new URL(base.href).hostname),
    environment,
    identity: identity ?? (declaredBase === undefined ? undefined : `${declaredBase.origin}${declaredBase.basePath}`),
    command,
    readyUrl: command === undefined ? undefined : readyUrl,
    services: resolveServices(declared.services, projectRoot, `${where} app.services`, expand),
  };
}

/** The request a URL declared with port 0 makes, carrying the port the run assigned it so far. */
function freePortRequest(declaredBase: NormalizedBaseUrl, port: number | undefined): PortRequest | undefined {
  if (!requestsFreePort(declaredBase)) return undefined;
  return { host: new URL(declaredBase.href).hostname, port };
}

/** The token a command, a service, or a readiness URL writes where the app's port goes. */
const PORT_TOKEN = '{port}';

/** Substitutes `{port}` in one configured value, given where the value came from for the error. */
type PortExpander = (value: string, label: string) => string;

/**
 * Substitutes `{port}` in one configured string. A target without a URL has
 * no port to offer, so the token there is a config error naming the field.
 */
function expandPort(value: string, port: number | undefined, label: string): string {
  if (!value.includes(PORT_TOKEN)) return value;
  if (port === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} uses ${PORT_TOKEN}, but the target declares no url to take the port from`,
    );
  }
  return value.replaceAll(PORT_TOKEN, String(port));
}

/**
 * The command with `{port}` expanded in every `args` entry and `env` value.
 * Malformed shapes pass through untouched for `validateCommand` to name.
 */
function expandCommandPort<T extends CommandConfig>(command: T, label: string, expand: PortExpander): T {
  if (typeof command !== 'object' || command === null) return command;
  const { args, env } = command;
  return {
    ...command,
    ...(Array.isArray(args)
      ? { args: args.map((arg) => (typeof arg === 'string' ? expand(arg, `${label}.args`) : arg)) }
      : {}),
    ...(typeof env === 'object' && env !== null
      ? {
          env: Object.fromEntries(
            Object.entries(env).map(([key, value]) => [
              key,
              typeof value === 'string' ? expand(value, `${label}.env.${key}`) : value,
            ]),
          ),
        }
      : {}),
  };
}

/** The keys of a `CommandConfig`: an app command and a service teardown take these only. */
const COMMAND_KEYS: readonly string[] = [
  'executable',
  'args',
  'cwd',
  'env',
  'startupTimeout',
  'shutdownTimeout',
  'log',
  'reuseExisting',
];

/** The keys of a `ServiceConfig`: a command's, plus what steers the service. */
const SERVICE_KEYS: readonly string[] = [...COMMAND_KEYS, 'name', 'readyUrl', 'waitForExit', 'teardown'];

/**
 * The shape every spawned command shares: only the `keys` it takes, a
 * non-empty executable, string `args` and `env` values, when set positive
 * integer timeouts, and when set a `log` path inside the project root. A
 * misspelled key would otherwise be dropped without a word; a NaN or
 * infinite budget would make the readiness loop spin without a deadline; a
 * log outside the root would let config write anywhere.
 */
function validateCommand(
  command: CommandConfig,
  label: string,
  projectRoot: string,
  keys: readonly string[] = COMMAND_KEYS,
): void {
  if (typeof command !== 'object' || command === null) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be an object`);
  }
  for (const key of Object.keys(command)) {
    if (!keys.includes(key)) {
      const hint = didYouMean(key, keys);
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${label} has unknown key "${key}"${hint === '' ? `; expected one of ${keys.join(', ')}` : hint}`,
      );
    }
  }
  if (typeof command.executable !== 'string' || command.executable.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.executable is required`);
  }
  if (command.args !== undefined) {
    if (!Array.isArray(command.args)) throw new ConfigurationError('INVALID_CONFIG', `${label}.args must be an array of strings`);
    command.args.forEach((arg: unknown, index) => requireString(arg, `${label}.args[${index}]`));
  }
  if (command.env !== undefined) {
    if (typeof command.env !== 'object' || command.env === null || Array.isArray(command.env)) {
      throw new ConfigurationError('INVALID_CONFIG', `${label}.env must be an object of variable name to string`);
    }
    for (const [key, value] of Object.entries(command.env)) requireString(value, `${label}.env.${key}`);
  }
  positiveInt(command.startupTimeout, `${label}.startupTimeout`, 'milliseconds');
  positiveInt(command.shutdownTimeout, `${label}.shutdownTimeout`, 'milliseconds');
  if (command.log !== undefined) {
    if (typeof command.log !== 'string' || command.log.trim() === '') {
      throw new ConfigurationError('INVALID_CONFIG', `${label}.log must be a non-empty path`);
    }
    if (!insideProjectRoot(projectRoot, path.resolve(projectRoot, command.log))) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${label}.log must be a file inside the project root, got ${JSON.stringify(command.log)}`,
      );
    }
  }
  if (command.reuseExisting !== undefined && typeof command.reuseExisting !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.reuseExisting must be a boolean`);
  }
}

/**
 * Refuses a command value that is not a string. A `secrets.get()` handle is
 * named as one: the child process would receive `[object Object]`, and only
 * an engine option that declares secrets resolves a handle to its value.
 */
function requireString(value: unknown, label: string): void {
  if (typeof value === 'string') return;
  if (isSecret(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be a string, got secrets.get(${JSON.stringify(value.name)}): only an engine option that declares secrets accepts a handle, such as web({ basicAuth: { password } }); pass the value itself, read from process.env`,
    );
  }
  throw new ConfigurationError('INVALID_CONFIG', `${label} must be a string, got ${describeValue(value)}`);
}

/** Only a command with a URL to probe can find something already answering there. */
function rejectReuse(command: CommandConfig, label: string, reason: string): void {
  if (command.reuseExisting !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.reuseExisting needs readyUrl: ${reason}`);
  }
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
 * (`name`, `readyUrl`, `waitForExit`, `teardown`) are lifted out of the
 * command; `reuseExisting` stays on it, and only a `readyUrl` service may set it.
 * `projectRoot` anchors each `log` path; `prefix` names the declaring target
 * in errors, so a failing service is traceable to the engine that declared it.
 * `expand` substitutes `{port}` in each service's args, env, readiness URL,
 * and teardown; the default leaves values as written.
 */
export function resolveServices(
  raw: EngineAppDeclaration['services'],
  projectRoot: string,
  prefix = 'app.services',
  expand: PortExpander = (value) => value,
): readonly ResolvedService[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', `${prefix} must be an array`);
  }
  const names = new Set<string>();
  return raw.map((declaredService: ServiceConfig, index): ResolvedService => {
    const position = `${prefix}[${index}]`;
    const service = expandCommandPort(declaredService, position, expand);
    validateCommand(service, position, projectRoot, SERVICE_KEYS);
    const { name: _name, readyUrl: rawReadyUrl, waitForExit, teardown: declaredTeardown, ...command } = service;
    const readyUrl = httpUrl(
      rawReadyUrl === undefined ? undefined : expand(rawReadyUrl, `${position}.readyUrl`),
      `${position}.readyUrl`,
    );
    const teardown =
      declaredTeardown === undefined ? undefined : expandCommandPort(declaredTeardown, `${position}.teardown`, expand);
    if ((readyUrl !== undefined) === (waitForExit === true)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${position} needs exactly one readiness contract: set readyUrl or waitForExit: true`,
      );
    }
    const readiness: Readiness = readyUrl === undefined ? { waitForExit: true } : { readyUrl };
    if (readyUrl === undefined) rejectReuse(command, position, 'a waitForExit service has nothing to reuse');
    const name = serviceName(service, position, names);
    const label = `service "${name}"`;
    if (teardown !== undefined) {
      validateCommand(teardown, `${position}.teardown`, projectRoot);
      rejectReuse(teardown, `${position}.teardown`, 'a teardown command has nothing to reuse');
    }
    return {
      label,
      name: service.name === undefined ? undefined : name,
      command,
      readiness,
      teardown: teardown === undefined ? undefined : { label: `${label} teardown`, command: teardown },
    };
  });
}

/** A command's env as it enters the config digest: values reduced to their names. */
interface DigestedEnv {
  readonly env?: Readonly<Record<string, { envName: string }>>;
}

function digestCommand<T extends CommandConfig>(command: T): Omit<T, 'env'> & DigestedEnv {
  const { env, ...rest } = command;
  if (env === undefined) return rest;
  return { ...rest, env: Object.fromEntries(Object.keys(env).map((key) => [key, { envName: key }])) };
}

/**
 * The declarative part of an engine's `app` manifest as it enters the config
 * digest: hooks stripped, and every `command.env`, service env, and service
 * teardown env value replaced by `{ envName: key }`, so no environment value
 * contributes to the digest.
 */
export function digestAppDeclaration(app: EngineAppDeclaration) {
  const { url, environment, identity, command, readyUrl, services } = app;
  return obj({
    url,
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
