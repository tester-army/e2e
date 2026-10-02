/**
 * Per-target app resolution: the `app` a target declares, checked field by
 * field and by the target's engine where an error can name the target. An
 * `app.command` becomes the target's own process in the service resolution
 * (`app:<target>`), and `app.url` then reads that process's address like any
 * service placeholder.
 */

import type { EngineAppDeclaration, EngineAppInfo, EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { rejectUnknownKeys } from '../internal/options.ts';
import { serviceTokens, tokenOf } from '../internal/service-tokens.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isImplicitTestHost, normalizeBaseUrl, requestsFreePort, siteOf, type NormalizedBaseUrl } from '../internal/urls.ts';
import type { AppPermissionState, CommandConfig, TargetApp } from '../types.ts';
import { isRecord, normalizeCommand } from './command.ts';
import { httpUrl } from './validate.ts';
import { bindTokens, checkTargetTokens, processTemplate, type ProcessTemplate, type ResolvedService, type ServiceTemplate } from './services/index.ts';

/** A target's `app` as checked: every field's shape, every placeholder as its token text. */
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
 * The app one target drives, as the harness resolved the target's `app`
 * declaration. Navigation policy, cache and session identity, the report's
 * target record, and the engine's app info all read from here; a target that
 * declares nothing gets the empty resolution.
 */
export interface ResolvedApp {
  /** Normalized base URL on the run's ports; undefined for a surface without addressable locations. */
  readonly base: NormalizedBaseUrl | undefined;
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
export const TARGET_KEYS: ReadonlySet<string> = new Set(['name', 'platform', 'engine', 'app', 'services', 'trace', 'video']);

/** Why a key is not a target's, with the nearest one when it reads like a typo. */
export function unknownTargetKey(where: string, key: string): ConfigurationError {
  return new ConfigurationError(
    'INVALID_CONFIG',
    `${where} has unknown key "${key}"; a target is { name?, platform?, engine?, app?, services?, trace?, video? }${didYouMean(key, [...TARGET_KEYS])}`,
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

/**
 * The process a target's `app.command` is, as a template of the service
 * resolution, and `app.url` as that resolution reads it. The command serves
 * `app.url` (its port is `{port}`) and is probed at `app.readyUrl`, else at
 * `app.url`; it runs after every service of the target's graph, whose
 * addresses it may read. A `url` a service serves has no command of its
 * own, and a free port nothing starts on is refused.
 */
export function appProcess(
  targetName: string,
  app: TargetAppDeclaration,
  graph: readonly string[],
  templates: ReadonlyMap<string, ServiceTemplate>,
  projectRoot: string,
): { readonly template: ProcessTemplate | undefined; readonly url: string | undefined } {
  const where = `target "${targetName}"`;
  const [served] = app.url === undefined ? [] : serviceTokens(app.url);
  if (app.command === undefined) {
    // Nothing probes a readyUrl without a command; its shape is still checked, like every field.
    if (app.readyUrl !== undefined) httpUrl(app.readyUrl.replaceAll('{port}', '1'), `${where} app.readyUrl`);
    if (app.url === undefined) return { template: undefined, url: undefined };
    checkTargetTokens(app.url, `${where} app.url`, targetName, graph, templates);
    if (served === undefined && requestsFreePort(normalizeBaseUrl(app.url))) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} app.url asks for a free port (port 0), but nothing starts on it: add app.command to start the app there on {port}, or serve the target from a service, app: { url: webServer.url }`,
      );
    }
    return { template: undefined, url: app.url };
  }
  if (served !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} app.url is the address of service "${served.service}", which serves the app, and app.command would start a second process there; drop app.command, or give the target an app.url of its own`,
    );
  }
  if (app.url === undefined && app.readyUrl === undefined) {
    throw new ConfigurationError('APP_URL_REQUIRED', `${where} declares app.command without a URL to poll: declare app.url or app.readyUrl beside it`);
  }
  const base = app.url === undefined ? undefined : normalizeBaseUrl(app.url);
  const name = `app:${targetName}`;
  const origin = base === undefined ? undefined : new URL(base.href);
  const template = processTemplate(
    {
      name,
      label: `${where} command`,
      role: 'app',
      where: `${where} app.command`,
      readyWhere: `${where} app.readyUrl`,
      command: app.command,
      readyUrl: app.readyUrl ?? (origin === undefined ? undefined : `${origin.protocol}//${origin.hostname}:{port}${origin.pathname}`),
      ports: {},
      teardown: undefined,
      serves: base,
      dependencies: graph,
    },
    templates,
    projectRoot,
  );
  return { template, url: base === undefined ? undefined : `${tokenOf(name, 'url')}${base.basePath}` };
}

/**
 * The base URL `url` reads on the resolved services' ports. A placeholder
 * that reads as no app URL (a service's smtp address) is named as written,
 * with the target, not as the `:0` address it stands for.
 */
function baseUrl(targetName: string, url: string, services: ReadonlyMap<string, ResolvedService>): NormalizedBaseUrl {
  const bound = bindTokens(url, services);
  try {
    return normalizeBaseUrl(bound);
  } catch (cause) {
    const [token] = serviceTokens(url);
    if (token === undefined || !(cause instanceof ConfigurationError)) throw cause;
    const address = `service "${token.service}"'s ${token.port === undefined ? 'primary' : token.port} ${token.kind === 'url' ? 'address' : 'port'}`;
    throw new ConfigurationError(
      'INVALID_APP_URL',
      `target "${targetName}" app.url is ${url}, ${address}, which a target cannot open: ${cause.message.replaceAll(bound, url)}`,
      { cause },
    );
  }
}

/**
 * Resolves one target's app from its checked declaration, `url` as the
 * service resolution reads it, and the services bound without the run's
 * ports: the identity keeps a free port's declared 0, so cache and session
 * entries survive the port changing every run.
 */
export function resolveTargetApp(
  targetName: string,
  app: TargetAppDeclaration,
  url: string | undefined,
  services: ReadonlyMap<string, ResolvedService>,
): ResolvedApp {
  const base = url === undefined ? undefined : baseUrl(targetName, url, services);
  const hostname = base === undefined ? undefined : new URL(base.href).hostname;
  return {
    base,
    site: hostname === undefined ? undefined : siteOf(hostname),
    environment: app.environment ?? (hostname !== undefined && !isImplicitTestHost(hostname) ? 'production' : 'test'),
    identity: app.identity ?? (base === undefined ? undefined : `${base.origin}${base.basePath}`) ?? app.bundleId ?? app.appPath,
    bundleId: app.bundleId,
    appPath: app.appPath,
    launchArguments: app.launchArguments,
    permissions: app.permissions,
  };
}

/** The app with its base URL, `url` bound on `services`' ports; everything else was settled without them. */
export function bindTargetApp(targetName: string, app: ResolvedApp, url: string | undefined, services: ReadonlyMap<string, ResolvedService>): ResolvedApp {
  return url === undefined ? app : { ...app, base: baseUrl(targetName, url, services) };
}

/** What `prepare` and `init` receive about the target's app: its site policy and what a device launches. */
export function engineAppInfo(app: ResolvedApp): EngineAppInfo {
  const { site, bundleId, appPath, launchArguments, permissions } = app;
  return obj({ site, bundleId, appPath, launchArguments, permissions });
}

/**
 * A target's app as it enters the config digest: everything but the base
 * URL, which carries the ports the run assigns (the target digests the URL
 * as declared), and the site, which the URL implies. An `app.command` enters
 * with the services, as the process it is.
 */
export function digestTargetApp(app: ResolvedApp) {
  const { base: _base, site: _site, ...facts } = app;
  return obj(facts);
}
