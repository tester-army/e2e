/**
 * What a run and a standalone attempt both do before the first engine
 * session: grade each target against its engine declaration, run the
 * engines' `prepare` hooks, and start the app processes the engines declare.
 * One owner, so the dev-loop session (`e2e mcp`) and a test run can never
 * provision differently.
 */

import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { EnginePrepareResult } from '../engine/index.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, translateProvisioningError } from '../internal/errors.ts';
import { describeTarget, type TargetProvenance } from '../report/build.ts';
import { declaredProcesses } from './declared-processes.ts';
import { ManagedProcess, ServiceStack, type ManagedProcessHooks } from './managed-process.ts';

/**
 * Grades one target from its engine declaration and validates the configured
 * artifacts against it; returns the report provenance.
 */
export function validateEngine(target: ResolvedTarget, config: ResolvedConfig): TargetProvenance {
  const provenance = describeTarget(target);
  // A best-effort kind is captured when the engine can; a required one is a
  // contract the engine must be able to honour before any test starts.
  for (const [artifact, policy] of config.artifacts) {
    if (policy === 'required' && !provenance.artifactCapabilities.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `target "${target.name}" (engine ${provenance.engine.name}) does not support the configured "${artifact}" artifact`,
      );
    }
  }
  return provenance;
}

export interface PrepareScope {
  readonly runId: string;
  /** The config's directory, where an engine resolves a relative option (a build path). */
  readonly projectRoot: string;
  /** The same `env` the workers are started with: what prepare provisions must be where a launch will look for it. */
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

/**
 * Runs one target's `prepare` hook for `slots` worker slots, streaming its
 * progress lines to `log`. Resolves to nothing when the engine declares no
 * hook. Callers run targets in turn: two engines provisioning the same
 * toolchain would race, and the notices of one download read better than
 * two interleaved.
 */
export async function prepareEngine(
  target: ResolvedTarget,
  slots: number,
  scope: PrepareScope,
  log: (line: string) => void,
): Promise<EnginePrepareResult | void> {
  const engine = target.engine;
  if (engine?.prepare === undefined) return;
  try {
    return await engine.prepare({
      runId: scope.runId,
      targetName: target.name,
      projectRoot: scope.projectRoot,
      slots,
      env: scope.env,
      signal: scope.signal,
      log,
    });
  } catch (cause) {
    throw translateProvisioningError(cause, ` while preparing engine ${engine.name} for target "${target.name}"`);
  }
}

/**
 * Runs one target's `finish` hook within the cleanup budget, streaming its
 * progress lines to `log`. Called for every target whose `prepare` was
 * called, whether or not it succeeded, so what a hook acquired before it
 * failed is still released. Resolves to nothing when the engine declares no
 * hook; a failure is the caller's to record as a cleanup error.
 */
export async function finishEngine(
  target: ResolvedTarget,
  scope: PrepareScope & { readonly timeoutMs: number },
  log: (line: string) => void,
): Promise<void> {
  const engine = target.engine;
  if (engine?.finish === undefined) return;
  const budget = AbortSignal.any([scope.signal, AbortSignal.timeout(scope.timeoutMs)]);
  try {
    await engine.finish({ runId: scope.runId, targetName: target.name, env: scope.env, signal: budget, timeoutMs: scope.timeoutMs, log });
  } catch (cause) {
    throw translateProvisioningError(cause, ` while finishing engine ${engine.name} for target "${target.name}"`);
  }
}

/** The app processes one run or session started, torn down in reverse. */
export interface AppProcesses {
  /**
   * Stops the app commands, then the services and their teardown commands.
   * Every failure is reported through `onFailure` and never skips the rest,
   * so one failing stop cannot leave the others running.
   */
  stop(onFailure: (cause: unknown) => void): Promise<void>;
}

/** The hooks each kind of process reports through; a run narrates them as distinct setup steps. */
export type ProcessHooks = (kind: 'service' | 'app') => ManagedProcessHooks;

/**
 * Starts what the targets' engines declare: the dependency services first,
 * then every distinct app command. Declarations are deduplicated across
 * targets (two browsers on one dev server share one process), and every
 * service is ready before the first app command starts. Nothing spawns once
 * `signal` aborted; what did start is returned for teardown either way.
 */
export async function startDeclaredProcesses(
  targets: readonly ResolvedTarget[],
  projectRoot: string,
  hooks: ProcessHooks,
  signal: AbortSignal,
  debug: DebugTrace,
): Promise<AppProcesses> {
  const declared = declaredProcesses(targets);
  let services: ServiceStack | undefined;
  const apps: ManagedProcess[] = [];
  const processes: AppProcesses = {
    async stop(onFailure) {
      for (const app of apps.splice(0).toReversed()) {
        try {
          await app.stop();
        } catch (cause) {
          onFailure(cause);
        }
      }
      await services?.stop(onFailure);
    },
  };
  try {
    if (declared.services.length > 0) {
      const stack = new ServiceStack(declared.services, projectRoot, hooks('service'));
      services = stack;
      await debug.time('app.services.start', () => stack.start(signal));
      if (signal.aborted) return processes;
    }
    for (const { label, command, readyUrl } of declared.commands) {
      const app = new ManagedProcess(label, command, projectRoot, { readyUrl }, hooks('app'));
      apps.push(app);
      await debug.time(`app.start(${label})`, () => app.start(signal));
      if (signal.aborted) return processes;
    }
    return processes;
  } catch (cause) {
    // A service or command that failed to start must not leave the earlier
    // ones running; the startup failure is the one reported, so a cleanup
    // failure here is a notice at most.
    await processes.stop((failure) => hooks('app').notice?.(`cleanup after a failed start: ${String(failure)}`));
    throw cause;
  }
}
