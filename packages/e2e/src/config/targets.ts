/**
 * Target resolution: each target's name, platform, engine, app, and the
 * services it needs, resolved once without the run's ports; `bindTargets`
 * puts a run's assigned ports in afterwards, and nothing else.
 */

import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ResolvedRecording } from '../internal/recording-modes.ts';
import type { Target } from '../types.ts';
import { isRecord } from './command.ts';
import { describeValue } from './validate.ts';
import { appProcess, bindTargetApp, checkTargetApp, digestTargetApp, resolveTargetApp, TARGET_KEYS, unknownTargetKey, type ResolvedApp } from './app.ts';
import {
  bindServices,
  collectServices,
  digestServices,
  portRequests,
  rejectSharedProbes,
  serviceTemplates,
  type PortAssignments,
  type PortRequest,
  type ResolvedService,
} from './services/index.ts';

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: string;
  /** Validated engine; undefined for an agent-tools-only target. */
  readonly engine: EngineHandle | undefined;
  /** The app under test, its base URL on the run's ports once they were assigned. */
  readonly app: ResolvedApp;
  /**
   * `app.url` as the service resolution reads it: a service's or the app
   * command's placeholder, or the URL itself. What `bindTargets` binds on the
   * run's ports, and what the digest keys the URL on.
   */
  readonly appUrl: string | undefined;
  /** The services the target needs, in start order: its own, every one they depend on, and last its `app.command`'s process. */
  readonly services: readonly string[];
  /** Which attempts on the target record a trace: `--trace`, else the target's `trace`, else the config's, else `on` (`on-first-retry` in CI). A test's own `trace` wins over it. */
  readonly trace: ResolvedRecording;
  /** Which attempts on the target record a video: `--video`, else the target's `video`, else the config's, else `off`. A test's own `video` wins over it. */
  readonly video: ResolvedRecording;
}

/** The targets, every service they need in start order, and the free ports those ask the run for. */
export interface ResolvedTargets {
  readonly targets: readonly ResolvedTarget[];
  readonly services: ReadonlyMap<string, ResolvedService>;
  readonly portRequests: readonly PortRequest[];
}

/** A safe artifact path segment: the filename alphabet, and never `.` or `..`, which would name a directory's self or parent. */
export const TARGET_NAME_PATTERN = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

/**
 * Resolves `targets`: each target's name, platform, engine, recordings, and
 * app, then the services every target needs with each target's
 * `app.command` last, bound without ports, so every address reads as
 * declared, then each target's app on those addresses.
 */
export function resolveTargets(
  declared: unknown,
  projectRoot: string,
  recordings: (target: Target, where: string) => Pick<ResolvedTarget, 'trace' | 'video'>,
): ResolvedTargets {
  if (declared === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'targets is required: declare at least one target and the engine that drives it, e.g. targets: [{ engine }]',
    );
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'targets must be a non-empty array');
  }
  const seen = new Set<string>();
  const defaulted = new Set<string>();
  const checked = (declared as readonly unknown[]).map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigurationError('INVALID_CONFIG', `targets[${index}] must be an object, got ${describeValue(entry)}`);
    const target = entry as Target;
    // Errors raised before the name settles point at the entry itself.
    const where = typeof target.name === 'string' ? `target "${target.name}"` : `targets[${index}]`;
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.has(key)) throw unknownTargetKey(where, key);
    }
    if (target.engine !== undefined && !isEngineHandle(target.engine)) {
      const got = typeof target.engine === 'string' ? `the string ${JSON.stringify(target.engine)}` : `a ${typeof target.engine}`;
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} engine must be an engine handle, got ${got}; call the engine's factory: web() from @e2e-dev/web, mobile({ platform }) from @e2e-dev/mobile, or your own defineEngine(...)`,
      );
    }
    const platform = resolvePlatform(target, where);
    const name = target.name === undefined ? platform : target.name;
    if (typeof name !== 'string' || !TARGET_NAME_PATTERN.test(name)) {
      const source = target.name === undefined ? ' (defaulted from the platform)' : '';
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid target name ${JSON.stringify(name)}${source}; target names are limited to ASCII letters, numbers, "_", "-", and ".", and cannot be only dots`,
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
    const app = checkTargetApp(name, target.engine, target.app);
    return { name, index, platform, engine: target.engine, app, declaredServices: target.services as unknown, ...recordings(target, where) };
  });
  const collected = collectServices(checked.map(({ name, declaredServices }) => ({ name, services: declaredServices })));
  const templates = serviceTemplates(collected, projectRoot);
  const withProcesses = checked.map((target) => {
    const graph = collected.graphs.get(target.name) ?? [];
    const { template, url } = appProcess(target.name, target.app, graph, templates, projectRoot);
    return { target, url, graph: template === undefined ? graph : [...graph, template.name], template };
  });
  for (const { template } of withProcesses) if (template !== undefined) templates.set(template.name, template);
  const services = bindServices(templates.values(), {});
  rejectSharedProbes(services.values());
  const targets = withProcesses.map(({ target: { declaredServices: _services, app, ...target }, url, graph }): ResolvedTarget => ({
    ...target,
    app: resolveTargetApp(target.name, app, url, services),
    appUrl: url,
    services: graph,
  }));
  return { targets, services, portRequests: portRequests(templates.values()) };
}

/**
 * The targets and services on the run's `ports`: every placeholder and each
 * base URL read on the assigned ports. Identities, digests, and every check
 * were settled without them.
 */
export function bindTargets(
  resolved: Pick<ResolvedTargets, 'targets' | 'services'>,
  ports: PortAssignments,
): Pick<ResolvedTargets, 'targets' | 'services'> {
  const services = bindServices([...resolved.services.values()].map((service) => service.template), ports);
  return { services, targets: resolved.targets.map((target) => ({ ...target, app: bindTargetApp(target.name, target.app, target.appUrl, services) })) };
}

/**
 * The targets and their services as they enter the config digest. An engine
 * handle holds live functions; its digest identity is the declaration -
 * name, version, contract version, the platform it drives (a named target
 * inherits it, so two workers whose engines declare different platforms
 * must not agree on the digest), and capability set. The app and every
 * service enter once, env values reduced to their names and the run's ports
 * never.
 */
export function digestTargets(resolved: Pick<ResolvedTargets, 'targets' | 'services'>) {
  return {
    targets: resolved.targets.map(({ name, platform, engine, app, appUrl, services }) => ({
      name,
      platform,
      app: digestTargetApp(app),
      appUrl,
      services,
      ...(engine === undefined
        ? {}
        : {
            engine: {
              name: engine.name,
              ...(engine.version === undefined ? {} : { version: engine.version }),
              spiVersion: engine.spiVersion,
              ...(engine.platform === undefined ? {} : { platform: engine.platform }),
              ...(engine.workers === undefined ? {} : { workers: engine.workers }),
              capabilities: [...engine.capabilities].toSorted(),
            },
          }),
    })),
    services: digestServices(resolved.services.values()),
  };
}

/**
 * The target's platform: its own label, else the engine's declaration. Tool
 * packs are offered by the engine's platform while tests filter by the
 * target's, so a target that names one while its engine declares another is a
 * mistake, not an override.
 */
function resolvePlatform(target: Target, where: string): string {
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
