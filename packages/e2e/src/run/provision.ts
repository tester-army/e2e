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
import { ConfigurationError, InfrastructureError, translateProvisioningError } from '../internal/errors.ts';
import { Deadline, NEVER_ABORTS, withScopedBudget } from '../internal/time.ts';
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
  /** Where a hook's progress lines go, under the target they concern. */
  readonly notice: (targetName: string, line: string) => void;
}

export interface FinishScope {
  readonly runId: string;
  readonly env: NodeJS.ProcessEnv;
  /** The cleanup budget every prepared target shares. */
  readonly timeoutMs: number;
  readonly notice: (targetName: string, line: string) => void;
  /** Takes every failure; none skips another target's release. */
  readonly onFailure: (cause: unknown) => void;
}

/**
 * The prepare/finish pairing of a run or a standalone attempt, in one place:
 * every target whose `prepare` hook was called gets its `finish`, whatever
 * happened in between, so what a hook acquired before it failed is still
 * released. Both entry points hold one of these instead of re-deriving the
 * protocol.
 */
export class PreparedEngines {
  private readonly targets: ResolvedTarget[] = [];

  /**
   * Runs one target's `prepare` hook for `slots` worker slots, streaming its
   * progress lines as notices. Resolves to nothing when the engine declares
   * no hook. Callers run targets in turn: two engines provisioning the same
   * toolchain would race, and the notices of one download read better than
   * two interleaved.
   */
  async prepare(target: ResolvedTarget, slots: number, scope: PrepareScope): Promise<EnginePrepareResult | void> {
    const engine = target.engine;
    if (engine?.prepare === undefined) return;
    // Registered before the hook runs: a `prepare` that throws part-way still gets its `finish`.
    this.targets.push(target);
    try {
      return await engine.prepare({
        runId: scope.runId,
        targetName: target.name,
        projectRoot: scope.projectRoot,
        slots,
        env: scope.env,
        signal: scope.signal,
        log: (line) => scope.notice(target.name, line),
      });
    } catch (cause) {
      throw translateProvisioningError(cause, ` while preparing engine ${engine.name} for target "${target.name}"`);
    }
  }

  /**
   * Runs the `finish` hook of every prepared target, all at once under one
   * cleanup deadline: releases are independent, and a run should not wait
   * one budget per target. Each hook is bounded like engine disposal: it is
   * never cancelled by an interrupt, and one that ignores its signal is
   * abandoned at the deadline with `CLEANUP_TIMEOUT`.
   */
  async finish(scope: FinishScope): Promise<void> {
    const deadline = new Deadline(scope.timeoutMs);
    await Promise.all(
      this.targets.splice(0).map(async (target) => {
        const engine = target.engine;
        if (engine?.finish === undefined) return;
        // A handle's members are bound at `defineEngine`, so the hook travels on its own.
        const { finish } = engine;
        const timeoutMs = deadline.remaining();
        const label = `finishing engine ${engine.name} for target "${target.name}"`;
        const info = { runId: scope.runId, targetName: target.name, env: scope.env, timeoutMs, log: (line: string) => scope.notice(target.name, line) };
        try {
          await withScopedBudget(
            timeoutMs,
            NEVER_ABORTS,
            () => new InfrastructureError('CLEANUP_TIMEOUT', `${label} timed out`),
            (signal) => finish({ ...info, signal }),
          );
        } catch (cause) {
          scope.onFailure(translateProvisioningError(cause, ` while ${label}`));
        }
      }),
    );
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
