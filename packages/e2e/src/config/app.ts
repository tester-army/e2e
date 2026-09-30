/**
 * Per-target app resolution: the `app` a target declares, checked field by
 * field and by the target's engine where an error can name the target, then
 * resolved on the port the run assigned when `app.url` asked for a free one.
 */

import type { EngineAppDeclaration, EngineAppInfo, EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { rejectUnknownKeys } from '../internal/options.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isImplicitTestHost, normalizeBaseUrl, portOf, requestsFreePort, siteOf, withPort, type NormalizedBaseUrl } from '../internal/urls.ts';
import type { AppPermissionState, CommandConfig, TargetApp } from '../types.ts';
import { checkLog, digestCommand, isRecord, normalizeCommand } from './command.ts';
import { httpUrl } from './validate.ts';

/** A target's `app` as checked: every field's shape, nothing resolved yet. */
export interface TargetAppDeclaration {
  readonly url: string | undefined;
  readonly bundleId: string | undefined;
  readonly appPath: string | undefined;
  readonly identity: string | undefined;
  readonly environment: 'test' | 'staging' | 'production' | undefined;
  readonly launchArguments: readonly string[] | undefined;
  readonly permissions: Readonly<Record<string, AppPermissionState>> | undefined;
  readonly command: CommandConfig | undefined;
  readonly readyUrl: string | undefined;
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
 * The app one target drives, as the harness resolved the target's `app`
 * declaration. Navigation policy, cache and session identity, the report's
 * target record, the engine's app info, and the app process all read from
 * here; a target that declares nothing gets the empty resolution.
 */
export interface ResolvedApp {
  /** Normalized base URL on the run's port; undefined for a surface without addressable locations. */
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
   * else the base URL's origin and path as declared (a free port still 0),
   * else the bundle id, else the build path. Undefined when the target
   * declares none of them, so entries key on the target and environment
   * alone.
   */
  readonly identity: string | undefined;
  readonly bundleId: string | undefined;
  readonly appPath: string | undefined;
  readonly launchArguments: readonly string[] | undefined;
  readonly permissions: Readonly<Record<string, AppPermissionState>> | undefined;
  /** `app.command` with `{port}` expanded to the port the app is served on. */
  readonly command: CommandConfig | undefined;
  /** Readiness probe for `command`; defined whenever `command` is. */
  readonly readyUrl: string | undefined;
}

const ENVIRONMENTS: ReadonlySet<unknown> = new Set(['test', 'staging', 'production']);

const PERMISSION_STATES: ReadonlySet<unknown> = new Set(['grant', 'deny', 'reset']);

/** Every key a target's `app` takes, kept equal to `TargetApp` by the compiler. */
const TARGET_APP_KEYS: readonly string[] = Object.keys({
  url: true,
  bundleId: true,
  appPath: true,
  identity: true,
  environment: true,
  launchArguments: true,
  permissions: true,
  command: true,
  readyUrl: true,
} satisfies Record<keyof TargetApp, true>);

/** Keys a target itself takes; anything else is refused, naming where it belongs. */
export const TARGET_KEYS: ReadonlySet<string> = new Set(['name', 'platform', 'engine', 'app', 'trace', 'video']);

/** Said wherever a config still declares dependency services, which this version does not start. */
export const SERVICES_GONE =
  'services are gone from this version: the runner starts only the target\'s app.command, so start dependency processes before the run; a services API returns in a later release';

/** Keys authors put on a target that belong under its `app`, each with where it goes. */
const APP_TARGET_KEYS: Readonly<Record<string, string>> = {
  url: 'app.url',
  bundleId: 'app.bundleId',
  appPath: 'app.appPath',
  identity: 'app.identity',
  environment: 'app.environment',
  launchArguments: 'app.launchArguments',
  permissions: 'app.permissions',
  command: 'app.command',
  readyUrl: 'app.readyUrl',
  webServer: 'app.command and app.readyUrl',
};

/** Keys authors put on a target that belong to its engine. */
const ENGINE_TARGET_KEYS: ReadonlySet<string> = new Set(['browser', 'device']);

/** Why a key is not a target's, and where the fact it holds lives. */
export function unknownTargetKey(where: string, key: string): ConfigurationError {
  const under = APP_TARGET_KEYS[key];
  const hint =
    under !== undefined
      ? `; the app under test is declared under the target's app: ${under}`
      : key === 'services'
        ? `; ${SERVICES_GONE}`
        : ENGINE_TARGET_KEYS.has(key)
          ? '; browser and device options are engine options: engine: web({ ... }) or mobile({ ... })'
          : didYouMean(key, [...TARGET_KEYS]);
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${where} has unknown key "${key}"; a target is { name?, platform?, engine?, app?, trace?, video? }${hint}`,
  );
}

/** A present value that is not a non-empty string is a config error naming the field. */
function nonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Checks the shape of a target's `app` and hands what the engine reads of it
 * to the engine's `validateApp`. A target without an engine has nothing to
 * drive an app, so any `app` there is a mistake. Every field is checked
 * here, where the error can name the target; what each platform needs is the
 * engine's to say.
 */
export function checkTargetApp(targetName: string, engine: EngineHandle | undefined, declared: unknown): TargetAppDeclaration {
  const where = `target "${targetName}" app`;
  if (declared !== undefined && !isRecord(declared)) throw new ConfigurationError('INVALID_CONFIG', `${where} must be an object`);
  // The shape is checked field by field below; until then the declaration is what the types say it is.
  const app = (declared ?? {}) as TargetApp;
  if (Object.hasOwn(app, 'services')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} has unknown key "services"; ${SERVICES_GONE}`);
  }
  rejectUnknownKeys(where, app, TARGET_APP_KEYS);
  if (declared !== undefined && engine === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${targetName}" declares app without an engine; only an engine can drive an app, so name one: engine: web() or mobile({ platform })`,
    );
  }
  const { environment, launchArguments, permissions } = app;
  if (environment !== undefined && !ENVIRONMENTS.has(environment)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where}.environment must be one of test, staging, production, got ${JSON.stringify(environment)}`);
  }
  if (launchArguments !== undefined && (!Array.isArray(launchArguments) || !launchArguments.every((argument) => typeof argument === 'string'))) {
    throw new ConfigurationError('INVALID_CONFIG', `${where}.launchArguments must be an array of strings`);
  }
  if (permissions !== undefined && !isRecord(permissions)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where}.permissions must be an object of permission name to grant, deny, or reset`);
  }
  for (const [permission, state] of Object.entries(permissions ?? {})) {
    if (!PERMISSION_STATES.has(state)) {
      throw new ConfigurationError('INVALID_CONFIG', `${where}.permissions.${permission} must be grant, deny, or reset, got ${JSON.stringify(state)}`);
    }
  }
  const checked: TargetAppDeclaration = {
    url: nonEmptyString(app.url, `${where}.url`),
    bundleId: nonEmptyString(app.bundleId, `${where}.bundleId`),
    appPath: nonEmptyString(app.appPath, `${where}.appPath`),
    identity: nonEmptyString(app.identity, `${where}.identity`),
    environment,
    launchArguments,
    permissions,
    command: app.command === undefined ? undefined : normalizeCommand(app.command, `${where}.command`),
    readyUrl: nonEmptyString(app.readyUrl, `${where}.readyUrl`),
  };
  const { url, bundleId, appPath } = checked;
  engine?.validateApp?.(obj({ url, bundleId, appPath, launchArguments, permissions }) satisfies EngineAppDeclaration, { targetName });
  return checked;
}

/** The token a command or a readiness URL writes where the app's port goes. */
const PORT_TOKEN = '{port}';

/**
 * Substitutes `{port}` in one configured string. A target without a URL has
 * no port to offer, so the token there is a config error naming the field.
 */
function expandPort(value: string, port: number | undefined, label: string): string {
  if (!value.includes(PORT_TOKEN)) return value;
  if (port === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} uses ${PORT_TOKEN}, but the target declares no url to take the port from`);
  }
  return value.replaceAll(PORT_TOKEN, String(port));
}

/** The command with `{port}` expanded in every `args` entry and `env` value. */
function expandCommandPort(command: CommandConfig, label: string, port: number | undefined): CommandConfig {
  const { args, env } = command;
  return obj({
    ...command,
    args: args?.map((arg) => expandPort(arg, port, `${label}.args`)),
    env: env === undefined ? undefined : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandPort(value, port, `${label}.env.${key}`)])),
  });
}

/**
 * Resolves one target's app from its checked declaration. `port` is the free
 * port the run assigned to a URL declared with port 0: it replaces the 0 in
 * the base URL and the default readiness probe. The default identity keeps
 * the declared `:0`, so cache and session entries survive the port changing
 * every run. `{port}` in the command and its readiness URL expands to the
 * port the app is served on, assigned or fixed; while a requested port is
 * unassigned that is 0, so the config resolves the same way before and
 * after assignment. A free port nothing starts on, and `reuseExisting` on a
 * free port, are refused: what already answers cannot serve a port the run
 * assigns.
 */
export function resolveTargetApp(targetName: string, app: TargetAppDeclaration, projectRoot: string, port?: number): ResolvedApp {
  const where = `target "${targetName}"`;
  const declaredBase = app.url === undefined ? undefined : normalizeBaseUrl(app.url);
  const portRequest =
    declaredBase === undefined || !requestsFreePort(declaredBase) ? undefined : { host: new URL(declaredBase.href).hostname, port };
  const base = declaredBase !== undefined && portRequest?.port !== undefined ? withPort(declaredBase, portRequest.port) : declaredBase;
  const appPort = base === undefined ? undefined : portOf(base);
  const hostname = base === undefined ? undefined : new URL(base.href).hostname;

  if (app.command === undefined && portRequest !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} app.url asks for a free port (port 0), but nothing starts on it: add app.command to start the app there on {port}`,
    );
  }
  const command = app.command === undefined ? undefined : expandCommandPort(app.command, `${where} app.command`, appPort);
  if (command !== undefined) checkLog(command, `${where} app.command`, projectRoot);
  if (command?.reuseExisting === true && portRequest !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} app.command.reuseExisting cannot find an app already running on a free port: port 0 is a new port every run; give the app a fixed port, or drop reuseExisting`,
    );
  }
  const readyUrl =
    httpUrl(app.readyUrl === undefined ? undefined : expandPort(app.readyUrl, appPort, `${where} app.readyUrl`), `${where} app.readyUrl`) ?? base?.href;
  if (command !== undefined && readyUrl === undefined) {
    throw new ConfigurationError('APP_URL_REQUIRED', `${where} declares app.command without a URL to poll: declare app.url or app.readyUrl beside it`);
  }

  return {
    base,
    portRequest,
    site: hostname === undefined ? undefined : siteOf(hostname),
    environment: app.environment ?? (hostname !== undefined && !isImplicitTestHost(hostname) ? 'production' : 'test'),
    identity: app.identity ?? (declaredBase === undefined ? undefined : `${declaredBase.origin}${declaredBase.basePath}`) ?? app.bundleId ?? app.appPath,
    bundleId: app.bundleId,
    appPath: app.appPath,
    launchArguments: app.launchArguments,
    permissions: app.permissions,
    command,
    readyUrl: command === undefined ? undefined : readyUrl,
  };
}

/** What `prepare` and `init` receive about the target's app: its site policy and what a device launches. */
export function engineAppInfo(app: ResolvedApp): EngineAppInfo {
  const { site, bundleId, appPath, launchArguments, permissions } = app;
  return obj({ site, bundleId, appPath, launchArguments, permissions });
}

/**
 * A target's app as it enters the config digest: the declaration, with the
 * command's env values reduced to their names. The run's port never enters
 * it, so a worker handed the port reads the same digest.
 */
export function digestTargetApp(app: TargetAppDeclaration) {
  const { command, ...facts } = app;
  return obj({ ...facts, command: command === undefined ? undefined : digestCommand(command) });
}
