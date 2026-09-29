/**
 * What a run and a standalone attempt both do before the first engine
 * session: grade each target against its engine declaration, run the
 * engines' `prepare` hooks, and start the app processes the engines declare.
 * One owner, so the dev-loop session (`e2e mcp`) and a test run can never
 * provision differently.
 */

import { pairRecording, type TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { EnginePrepareResult } from '../engine/index.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, InfrastructureError, translateProvisioningError } from '../internal/errors.ts';
import { Deadline, NEVER_ABORTS, withScopedBudget } from '../internal/time.ts';
import { describeTarget, type TargetProvenance } from '../report/build.ts';
import { declaredProcesses, type DeclaredProcesses } from './declared-processes.ts';
import { isRetryMode, recordsOnSomeAttempt, type RecordingKind, type ResolvedRecording } from '../internal/recording-modes.ts';
import { ManagedProcess, ServiceStack, type ManagedProcessHooks } from './managed-process.ts';
import { UNSHARED, type ProcessPool } from './process-pool.ts';

const RECORDING_KINDS: readonly RecordingKind[] = ['trace', 'video'];

/** A target graded against its engine declaration, before any test starts. */
export interface EngineGrade {
  readonly provenance: TargetProvenance;
  /**
   * The recordings a run-wide mode (the config root, `--trace`, `--video`)
   * asks of this target that its engine cannot make. They are skipped, and
   * the run says so once (`unrecordedNotices`).
   */
  readonly unrecorded: readonly RecordingKind[];
}

/**
 * Grades one target from its engine declaration and validates the recordings
 * against it. A recording is graded from what will record: with the target's
 * `pairs` (a run), every test that runs and whose mode records on some
 * attempt; without them (a standalone attempt), the target's own mode. A mode
 * a target or a test set is required, so an engine that cannot record it
 * fails here, before any test starts; a run-wide mode applies where the
 * engine can record and is reported as `unrecorded` elsewhere, and a default
 * one is skipped quietly.
 */
export function validateEngine(target: ResolvedTarget, pairs?: readonly TestTargetPair[]): EngineGrade {
  const provenance = describeTarget(target);
  const unrecorded: RecordingKind[] = [];
  for (const kind of RECORDING_KINDS) {
    if (provenance.artifactCapabilities.includes(kind)) continue;
    const asked: { readonly recording: ResolvedRecording; readonly pair?: TestTargetPair }[] =
      pairs === undefined
        ? recordsOnSomeAttempt(target[kind].mode, 0) ? [{ recording: target[kind] }] : []
        : pairs.flatMap((pair) => {
            const recording = pairRecording(pair, kind);
            return pair.disposition === 'run' && recordsOnSomeAttempt(recording.mode, pair.options.retries) ? [{ recording, pair }] : [];
          });
    const required = asked.find(({ recording }) => recording.source === 'target' || recording.source === 'test');
    if (required !== undefined) {
      const where = `target "${target.name}" (engine ${provenance.engine.name}) cannot record ${kind === 'trace' ? 'a trace' : 'video'}`;
      const setBy =
        required.recording.source === 'test' && required.pair !== undefined
          ? `test "${required.pair.test.titlePath.join(' > ')}" in ${required.pair.test.file} sets`
          : 'the target sets';
      throw new ConfigurationError('UNSUPPORTED_ARTIFACT', `${where}, and ${setBy} ${kind}: '${required.recording.mode}'`);
    }
    if (asked.some(({ recording }) => recording.source === 'run')) unrecorded.push(kind);
  }
  return { provenance, unrecorded };
}

/**
 * The plan-time notices about recordings the run asked for and will not
 * make: one per kind naming every target whose engine cannot record what a
 * run-wide mode asked of it, and one per kind when tests that would record it
 * run under a retry mode with no retries, so no attempt of theirs records.
 * `explore` is a run of one attempt no config can retry, so its notice says
 * to pass the flag instead of setting retries.
 */
export function recordingNotices(
  perTarget: readonly { readonly target: ResolvedTarget; readonly pairs: readonly TestTargetPair[] }[],
  grades: ReadonlyMap<string, EngineGrade>,
  options: { readonly explore?: boolean } = {},
): string[] {
  const notices: string[] = [];
  for (const kind of RECORDING_KINDS) {
    const skipped = perTarget.filter(({ target }) => grades.get(target.name)?.unrecorded.includes(kind));
    if (skipped.length === 0) continue;
    const names = skipped.map(({ target }) => `"${target.name}" (engine ${grades.get(target.name)!.provenance.engine.name})`);
    notices.push(
      `${kind} records only on targets whose engine can record it; ${names.length === 1 ? 'target' : 'targets'} ${names.join(', ')} record${names.length === 1 ? 's' : ''} no ${kind}`,
    );
  }
  for (const kind of RECORDING_KINDS) {
    const notice = retryOnlyNotice(kind, perTarget, grades, options.explore === true);
    if (notice !== undefined) notices.push(notice);
  }
  return notices;
}

/**
 * The notice for one kind when tests whose engine can record it run under a
 * retry mode with `retries: 0`: no attempt of theirs records one. Undefined
 * when no such test runs.
 */
function retryOnlyNotice(
  kind: RecordingKind,
  perTarget: readonly { readonly target: ResolvedTarget; readonly pairs: readonly TestTargetPair[] }[],
  grades: ReadonlyMap<string, EngineGrade>,
  explore: boolean,
): string | undefined {
  const modes = new Set<string>();
  let unrecorded = 0;
  for (const { target, pairs } of perTarget) {
    if (!grades.get(target.name)?.provenance.artifactCapabilities.includes(kind)) continue;
    for (const pair of pairs) {
      const { mode } = pairRecording(pair, kind);
      if (pair.disposition !== 'run' || !isRetryMode(mode) || pair.options.retries > 0) continue;
      modes.add(`'${mode}'`);
      unrecorded += 1;
    }
  }
  if (unrecorded === 0) return undefined;
  const plural = kind === 'trace' ? 'traces' : 'videos';
  const asked = `${kind}: ${[...modes].join(' and ')} records retries only`;
  if (explore) return `${asked}, and explore runs its goal once, so no ${plural} will be recorded; pass --${kind} on`;
  const tests = unrecorded === 1 ? 'test runs' : 'tests run';
  return `${asked}, and ${unrecorded} ${tests} with retries: 0, so no ${plural} will be recorded for ${unrecorded === 1 ? 'it' : 'them'}; set retries, or ${kind}: 'on'`;
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
   * Stops the app commands, then each service followed by its teardown command, in reverse.
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
 * service is ready before the first app command starts. `pool` decides
 * whether each process is started for this call or shared with others that
 * declare it. Nothing more is acquired once `signal` aborted; what was
 * acquired is returned for release either way.
 */
export async function startDeclaredProcesses(
  targets: readonly ResolvedTarget[],
  projectRoot: string,
  hooks: ProcessHooks,
  signal: AbortSignal,
  debug: DebugTrace,
  pool: ProcessPool = UNSHARED,
): Promise<AppProcesses> {
  const held: AppProcesses[] = [];
  const processes: AppProcesses = {
    async stop(onFailure) {
      for (const unit of held.splice(0).toReversed()) await unit.stop(onFailure);
    },
  };
  // A cleanup failure after a failed start is a notice at most: the startup failure is the one reported.
  const cleanupNotice = (failure: unknown): void => hooks('app').notice?.(`cleanup after a failed start: ${String(failure)}`);
  try {
    for (const unit of processUnits(declaredProcesses(targets), projectRoot, hooks, debug, cleanupNotice)) {
      if (signal.aborted) return processes;
      held.push(await pool.acquire(`${projectRoot}\0${unit.key}`, unit.start, signal));
    }
    return processes;
  } catch (cause) {
    // A process that failed to start must not leave the earlier ones running.
    await processes.stop(cleanupNotice);
    throw cause;
  }
}

/** One process to start: a dependency service with its teardown, or an app command. */
interface ProcessUnit {
  /** What makes two declarations the same process. */
  readonly key: string;
  /** Starts a fresh instance; one that fails to start is stopped before the failure surfaces. */
  readonly start: (signal: AbortSignal) => Promise<AppProcesses>;
}

/** The declaration as units in start order: each service, then each app command; released in reverse, each service's teardown runs right after it stops. */
function processUnits(
  declared: DeclaredProcesses,
  projectRoot: string,
  hooks: ProcessHooks,
  debug: DebugTrace,
  onCleanupFailure: (cause: unknown) => void,
): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  for (const service of declared.services) {
    units.push({
      key: `service:${service.key}`,
      start: (signal) => {
        const stack = new ServiceStack([service], projectRoot, hooks('service'));
        return started(() => debug.time(`app.start(${service.label})`, () => stack.start(signal)), (onFailure) => stack.stop(onFailure), onCleanupFailure);
      },
    });
  }
  for (const { label, command, readyUrl, key } of declared.commands) {
    units.push({
      key: `command:${key}`,
      start: (signal) => {
        const app = new ManagedProcess(label, command, projectRoot, { readyUrl }, hooks('app'));
        return started(
          () => debug.time(`app.start(${label})`, () => app.start(signal)),
          async (onFailure) => {
            try {
              await app.stop();
            } catch (cause) {
              onFailure(cause);
            }
          },
          onCleanupFailure,
        );
      },
    });
  }
  return units;
}

/** Runs `start`; on failure runs `stop` before the failure surfaces, its own failures to `onCleanupFailure`. */
async function started(start: () => Promise<void>, stop: AppProcesses['stop'], onCleanupFailure: (cause: unknown) => void): Promise<AppProcesses> {
  try {
    await start();
  } catch (cause) {
    await stop(onCleanupFailure);
    throw cause;
  }
  return { stop };
}
