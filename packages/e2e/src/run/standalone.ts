/** The worker a hosted test runner or the one-shot MCP path keeps alive between attempts. */

import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { DebugTrace } from '../internal/debug.ts';
import { classifyError, InfrastructureError, serializeError, type SerializedError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { uuidv7 } from '../internal/ids.ts';
import { holdSecretRegistry } from '../secrets.ts';
import { TargetExecutor } from './execute.ts';
import type { AppProcesses } from './managed-process.ts';
import { outputLayout } from './output.ts';
import type { ProcessPool } from './process-pool.ts';
import { PreparedEngines, recordingNotices, startDeclaredProcesses, validateEngine } from './provision.ts';
import { processSecrets } from './secrecy.ts';
import { SessionStore } from './sessions.ts';
import {
  launchAttempt, reserveAttempt, type AttemptKind, type AttemptReservation, type StandaloneAttempt, type StandaloneSessionOptions,
} from './standalone-attempt.ts';

export type { StandaloneAttempt, StandaloneSessionOptions } from './standalone-attempt.ts';

export interface StandaloneHostOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly processes?: ProcessPool | undefined;
  readonly notice?: (target: string, message: string) => void;
  readonly debug?: DebugTrace;
}

export interface StandaloneAttemptOptions extends StandaloneHostOptions, StandaloneSessionOptions {}

export interface StandaloneHost {
  readonly runId: string;
  /** One attempt at a time: the next may open once the previous close settled. */
  openAttempt(options: StandaloneSessionOptions): Promise<StandaloneAttempt>;
  close(): Promise<readonly SerializedError[]>;
}

/**
 * Where the worker is between attempts. `retired` follows an attempt whose
 * engine cleanup failed: its isolation is uncertain, so no later attempt may
 * reuse the worker.
 */
type WorkerState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'opening'; readonly pending: Promise<StandaloneAttempt> }
  | { readonly phase: 'live'; readonly attempt: StandaloneAttempt }
  | { readonly phase: 'retired' };

const engineOwners = realmSlot<WeakSet<object>>('e2e.standalone.engines.v1');

function owners(): WeakSet<object> {
  let set = engineOwners.get(globalThis);
  if (set === undefined) {
    set = new WeakSet<object>();
    engineOwners.set(globalThis, set);
  }
  return set;
}

/** No host may drive an engine instance another host owns. */
function refuseOwnedEngine(engine: object | undefined): void {
  if (engine !== undefined && owners().has(engine)) throw new InfrastructureError('WORKER_PROTOCOL', 'the engine instance already belongs to an e2e host');
}

/** A hosted worker owns its engine from before prepare until its teardown settles cleanly. */
function claimEngine(engine: object | undefined): () => void {
  if (engine === undefined) return () => undefined;
  owners().add(engine);
  return () => owners().delete(engine);
}

/** Prepares, starts app processes, and initializes one worker for a hosted test runner. */
export function openStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost> {
  return openWorker(options, 'hosted');
}

/**
 * MCP's one attempt on a worker of its own, closed together. MCP keeps its own
 * engine ownership. The teardown of a test the attempt ran drives the app, so
 * it runs before the host's close cancels the attempt's operations.
 */
export async function openStandaloneAttempt(options: StandaloneAttemptOptions): Promise<StandaloneAttempt> {
  const host = await openWorker(options, 'one-shot');
  try {
    const attempt = await host.openAttempt(options);
    const close = async (): Promise<readonly SerializedError[]> => {
      const torn = (await attempt.test?.teardown()) ?? [];
      // A test's `beforeAll` failure is a run error too, and was its outcome when the session opened.
      const closed = (await host.close()).filter((error) => attempt.test === undefined || error.phase !== 'beforeAll');
      return [...torn, ...closed];
    };
    return { ...attempt, close };
  } catch (cause) {
    await host.close();
    throw cause;
  }
}

async function openWorker(options: StandaloneHostOptions, kind: AttemptKind): Promise<StandaloneHost> {
  const { config, target } = options;
  const hostEnd = new AbortController();
  const signal = AbortSignal.any([options.signal, hostEnd.signal]);
  const debug = options.debug ?? new DebugTrace(false);
  const notice = (targetName: string, message: string): void => {
    options.notice?.(processSecrets.redact(targetName), processSecrets.redact(message));
  };
  const runId = uuidv7();
  const grade = validateEngine(target);
  for (const message of recordingNotices([{ target, pairs: [] }], new Map([[target.name, grade]]))) notice(target.name, message);
  refuseOwnedEngine(target.engine);
  const releaseEngine = kind === 'hosted' ? claimEngine(target.engine) : () => undefined;
  const releaseRegistry = holdSecretRegistry(config);
  const engines = new PreparedEngines();
  const layout = outputLayout(config.output);
  const sessionStore = SessionStore.create(runId, layout.sessions);
  const errors: SerializedError[] = [];
  const failure = (cause: unknown): void => {
    errors.push(serializeError(classifyError(cause), { phase: 'cleanup', projectRoot: config.projectRoot, redact: processSecrets.redact }));
  };
  let processes: AppProcesses | undefined;
  let executor: TargetExecutor | undefined;
  let tearingDown: Promise<void> | undefined;
  /** Releases every owner once, whichever of host close or a retiring attempt gets there first. */
  const teardown = (): Promise<void> => {
    tearingDown ??= (async () => {
      // Attempt failures are the caller's to report; only teardown's own decide engine reuse.
      const priorFailures = errors.length;
      try {
        await executor?.dispose();
        errors.push(...(executor?.collectedRunErrors().map((error) => error.error) ?? []));
      } catch (cause) { failure(cause); }
      try {
        await engines.finish({ runId, env: options.env, timeoutMs: config.cleanupTimeout, notice, onFailure: failure });
      } catch (cause) { failure(cause); }
      try { await processes?.stop(failure); } catch (cause) { failure(cause); }
      try { sessionStore.cleanup(); } catch (cause) { failure(cause); }
      releaseRegistry();
      // Failed worker teardown cannot prove this same engine is safe to reuse.
      if (errors.length === priorFailures) releaseEngine();
    })();
    return tearingDown;
  };
  try {
    const prepared = await engines.prepare(target, 1, {
      runId, projectRoot: config.projectRoot, env: options.env, signal, headed: options.headed, notice,
    });
    const hooks = { ci: config.ci, env: options.env, notice: (message: string) => notice('app', message) };
    processes = await startDeclaredProcesses([target], config.projectRoot, () => hooks, signal, debug, options.processes);
    if (signal.aborted) throw new InfrastructureError('CANCELLED', `opening a host on target "${target.name}" was cancelled`);
    executor = new TargetExecutor({
      config, target, runId, artifactsRoot: layout.results, sessionStore,
      headed: options.headed, workerSlot: 0, env: { ...prepared?.env, ...options.env },
      isolated: false, interruptSignal: signal, debug,
      events: { onNotice: (message) => notice(target.name, message) },
    });
    await executor.initEngineOnce();
    if (signal.aborted) throw new InfrastructureError('CANCELLED', `opening a host on target "${target.name}" was cancelled`);
  } catch (cause) {
    hostEnd.abort();
    await teardown();
    for (const error of errors) notice(target.name, error.message);
    throw cause;
  }
  const worker = { kind, config, target, runId, executor, resultsDir: layout.results, debug, signal };
  let state: WorkerState = { phase: 'idle' };
  let closing: Promise<readonly SerializedError[]> | undefined;

  /** Cancels a launch before awaiting it, then ends the attempt before disposing its worker. */
  const close = (): Promise<readonly SerializedError[]> => {
    closing ??= (async () => {
      hostEnd.abort();
      if (state.phase === 'opening') await state.pending.catch(() => undefined);
      if (state.phase === 'live') {
        try {
          errors.push(...await state.attempt.close());
        } catch (cause) { failure(cause); }
      }
      await teardown();
      return errors;
    })();
    return closing;
  };

  /** Reserves the attempt synchronously, before any engine work can run. */
  const openAttempt = (sessionOptions: StandaloneSessionOptions): Promise<StandaloneAttempt> => {
    if (closing !== undefined || state.phase === 'retired') return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host is closed'));
    if (state.phase !== 'idle') return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host already has an opening, live, or closing session'));
    let reservation: AttemptReservation;
    try {
      reservation = reserveAttempt(worker, sessionOptions);
    } catch (cause) { return Promise.reject(cause); }
    const pending = launchAttempt(worker, reservation, async ({ cleanup }) => {
      if (cleanup === 'complete') {
        state = { phase: 'idle' };
        return;
      }
      state = { phase: 'retired' };
      hostEnd.abort();
      await teardown();
    }).then(
      (attempt) => {
        state = { phase: 'live', attempt };
        return attempt;
      },
      (cause: unknown) => {
        reservation.release();
        state = { phase: 'idle' };
        throw cause;
      },
    );
    state = { phase: 'opening', pending };
    return pending;
  };
  return { runId, openAttempt, close };
}
