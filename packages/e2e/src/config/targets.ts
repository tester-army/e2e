/**
 * Target resolution: each target's name, platform, engine, and app, resolved
 * once without the run's ports; `bindTargets` puts a run's assigned ports in
 * afterwards, and nothing else.
 */

import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ResolvedRecording } from '../internal/recording-modes.ts';
import type { ScreenshotMode, Target } from '../types.ts';
import { checkTargetApp, digestTargetApp, resolveTargetApp, TARGET_KEYS, unknownTargetKey, type ResolvedApp, type TargetAppDeclaration } from './app.ts';
import { isRecord } from './command.ts';
import { describeValue } from './validate.ts';

/** The free port the run assigned to each target whose URL asked for one, by target name. */
export type PortAssignments = Readonly<Record<string, number>>;

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: string;
  /** Validated engine; undefined for an agent-tools-only target. */
  readonly engine: EngineHandle | undefined;
  /** The app under test, on the run's port once it was assigned. */
  readonly app: ResolvedApp;
  /** The app as declared and checked: what `bindTargets` resolves again on the run's port, and what the digest reads. */
  readonly declaredApp: TargetAppDeclaration;
  /** Which attempts on the target record a trace: `--trace`, else the target's `trace`, else the config's, else `on` (`on-first-retry` in CI). A test's own `trace` wins over it. */
  readonly trace: ResolvedRecording;
  /** Which attempts on the target record a video: `--video`, else the target's `video`, else the config's, else `off`. A test's own `video` wins over it. */
  readonly video: ResolvedRecording;
  /** Which steps the runner screenshots on the target: `--screenshot`, else the target's `screenshot`, else the config's, else `every-step` while evidence is on and `on-failure` when it is off. A test's own `screenshot` wins over it. */
  readonly screenshot: ScreenshotMode;
}

/** A safe artifact path segment: the filename alphabet, and never `.` or `..`, which would name a directory's self or parent. */
export const TARGET_NAME_PATTERN = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Resolves `targets`: each target's name, platform, engine, recordings, screenshot mode, and app, without the run's ports. */
export function resolveTargets(
  declared: unknown,
  projectRoot: string,
  recordings: (target: Target, where: string) => Pick<ResolvedTarget, 'trace' | 'video' | 'screenshot'>,
): readonly ResolvedTarget[] {
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
  return (declared as readonly unknown[]).map((entry, index): ResolvedTarget => {
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
    const declaredApp = checkTargetApp(name, target.engine, target.app);
    return {
      name,
      index,
      platform,
      engine: target.engine,
      app: resolveTargetApp(name, declaredApp, projectRoot),
      declaredApp,
      ...recordings(target, where),
    };
  });
}

/**
 * The targets on the run's `ports`: each target's app resolved again on the
 * port assigned to it. Identities, digests, and every check were settled
 * without them.
 */
export function bindTargets(targets: readonly ResolvedTarget[], projectRoot: string, ports: PortAssignments): readonly ResolvedTarget[] {
  return targets.map((target) => ({ ...target, app: resolveTargetApp(target.name, target.declaredApp, projectRoot, Object.hasOwn(ports, target.name) ? ports[target.name] : undefined) }));
}

/**
 * The targets as they enter the config digest. An engine handle holds live
 * functions; its digest identity is the declaration - name, version,
 * contract version, the platform it drives (a named target inherits it, so
 * two workers whose engines declare different platforms must not agree on
 * the digest), and capability set. The app enters as declared, env values
 * reduced to their names and the run's port never.
 */
export function digestTargets(targets: readonly ResolvedTarget[]) {
  return targets.map(({ name, platform, engine, declaredApp }) => ({
    name,
    platform,
    app: digestTargetApp(declaredApp),
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
  }));
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
