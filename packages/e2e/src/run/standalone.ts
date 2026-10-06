/**
 * A standalone attempt: one engine session on one target, with the full
 * fixture graph, and no test body. This is what a dev-loop host (`e2e mcp`)
 * opens so a coding agent can drive the live app through the same `agent`,
 * `screen`, and `app` surfaces a test would, under the same launch budgets,
 * origin policy, secret handling, and cleanup as a test attempt. The runner
 * proper (`execute.ts`) keeps owning retries, sessions, and records; this
 * module only borrows its session lifecycle.
 */

import type { ExecutorAttempt } from '../agent/executor.ts';
import type { AgentContext } from '../agent/invocation.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { holdSecretRegistry } from '../secrets.ts';
import type { TargetSession } from '../engine/surface.ts';
import { DebugTrace } from '../internal/debug.ts';
import { classifyError, InfrastructureError, serializeError, type SerializedError } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
import type { TestFixtures } from '../types.ts';
import { createAttemptArtifacts } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { TargetExecutor, type ClosingRecord } from './execute.ts';
import { createFixtures } from './fixtures.ts';
import type { EnginePrepareResult } from '../engine/index.ts';
import type { ProcessPool } from './process-pool.ts';
import type { AppProcesses } from './managed-process.ts';
import { PreparedEngines, recordingNotices, startDeclaredProcesses, validateEngine } from './provision.ts';
import { attemptRecording, type AttemptRecording, type ResolvedRecording } from '../internal/recording-modes.ts';
import { redactForSession, sessionSecrecy } from './secrecy.ts';
import { SessionStore } from './sessions.ts';
import { outputLayout } from './output.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import { WorkerModels } from './worker-models.ts';

export interface StandaloneAttemptOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** Cancels the attempt wherever it is: provisioning, launch, or a fixture call. */
  readonly signal: AbortSignal;
  /** How long the attempt may live; every fixture operation is capped by it. */
  readonly timeoutMs: number;
  /** The configured agent the `agent` fixture runs as when a call names none; default the run's first. */
  readonly agent?: string | undefined;
  /** Who starts the declared app processes: each for this attempt alone by default, or a host's `SharedAppProcesses` to share them across attempts. */
  readonly processes?: ProcessPool | undefined;
  /** Run-level progress outside any step: engine provisioning, an app process. */
  readonly notice?: (target: string, message: string) => void;
  /** Live step progress, the same feed a run's reporters get. */
  readonly onProgress?: (progress: StepProgress) => void;
  readonly debug?: DebugTrace;
}

export interface StandaloneAttempt {
  readonly runId: string;
  readonly attemptId: string;
  /** The attempt's fixtures: `agent`, `app`, `screen`, and whatever the engine contributes. */
  readonly fixtures: TestFixtures;
  /** The runtime behind `fixtures.agent`, for a host that opens steps itself. */
  readonly agentRuntime: AgentContext;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  /** The attempt's signal and deadline, for a host that drives the session directly. */
  readonly budget: AttemptBudget;
  /** Absolute artifact directory of this attempt. */
  readonly artifactsDir: string;
  /**
   * Ends the attempt: stops any video, closes the session, disposes the
   * engine, stops the app processes, and returns the cleanup failures instead
   * of throwing them, so a host can always finish tearing down.
   */
  close(): Promise<readonly SerializedError[]>;
}

/**
 * Opens one attempt on the target: grades and prepares the engine, starts the
 * declared app processes, boots the engine, and starts the attempt. On any
 * failure everything that did start is torn down before the error surfaces.
 */
export async function openStandaloneAttempt(options: StandaloneAttemptOptions): Promise<StandaloneAttempt> {
  const { config, target, signal } = options;
  const debug = options.debug ?? new DebugTrace(false);
  const notice = options.notice ?? (() => undefined);
  const runId = uuidv7();
  const attemptId = uuidv7();

  // A session says what it will not record, as a run does at plan time.
  const grade = validateEngine(target);
  for (const message of recordingNotices([{ target, pairs: [] }], new Map([[target.name, grade]]))) notice(target.name, message);
  const video = sessionRecording(target.video);
  // The secret registry is process-wide, as in a run: `credentials.user()` and `secrets.get()`
  // resolve while the attempt is open.
  const releaseRegistry = holdSecretRegistry(config);
  let processes: AppProcesses;
  let prepared: EnginePrepareResult | void;
  const engines = new PreparedEngines();
  /** Releases what `prepare` acquired, under the cleanup budget; every failure goes to `onFailure`. */
  const finishEngines = (onFailure: (cause: unknown) => void): Promise<void> =>
    engines.finish({ runId, env: options.env, timeoutMs: config.cleanupTimeout, notice, onFailure });
  try {
    // One worker on one target: one slot to provision.
    prepared = await engines.prepare(target, 1, { runId, projectRoot: config.projectRoot, env: options.env, signal, headed: options.headed, notice });
    const hooks = { ci: config.ci, notice: (message: string) => notice('app', message) };
    processes = await startDeclaredProcesses([target], config.projectRoot, () => hooks, signal, debug, options.processes);
    if (signal.aborted) {
      // Cancelled before or while the processes started: what did start stops before the open fails.
      await processes.stop((failure) => notice(target.name, classifyError(failure).message));
      throw new InfrastructureError('CANCELLED', `opening an attempt on target "${target.name}" was cancelled`);
    }
  } catch (cause) {
    // No attempt exists yet to carry a cleanup error, and the opening error is
    // the one that surfaces; a release that fails on the way out is narrated.
    await finishEngines((failure) => notice(target.name, classifyError(failure).message));
    releaseRegistry();
    throw cause;
  }

  const layout = outputLayout(config.output);
  const sessionStore = SessionStore.create(runId, layout.sessions);
  const executor = new TargetExecutor({
    config,
    target,
    runId,
    artifactsRoot: layout.results,
    sessionStore,
    headed: options.headed,
    workerSlot: 0,
    env: { ...prepared?.env, ...options.env },
    isolated: false,
    interruptSignal: signal,
    debug,
    events: {
      onNotice: (message) => notice(target.name, message),
      ...(options.onProgress === undefined ? {} : { onProgress: (_testId: unknown, progress: StepProgress) => options.onProgress?.(progress) }),
    },
  });
  let session: TargetSession | undefined;
  const steps = new StepRecorder(attemptId, {
    maxEventsPerStep: config.limits.maxEventsPerStep,
    projectRoot: config.projectRoot,
    redact: (text) => redactForSession(session, config.allSecrets, text),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const artifacts = createAttemptArtifacts({
    artifactsRoot: layout.results,
    segments: ['mcp', `${target.name}-${attemptId}`],
    attemptId,
    currentStepId: () => steps.currentStepId,
    ...(config.artifactStore === undefined ? {} : { store: config.artifactStore }),
    secrecy: () => (session === undefined ? undefined : sessionSecrecy(session, config.allSecrets)),
    identity: { runId, testId: `session:${target.name}`, attemptId },
  });

  const cleanupErrors: SerializedError[] = [];
  const recordCleanupFailure = (cause: unknown): void => {
    cleanupErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
  };
  const teardownProcesses = async (): Promise<void> => {
    await finishEngines(recordCleanupFailure);
    await processes.stop(recordCleanupFailure);
    try {
      sessionStore.cleanup();
    } catch (cause) {
      recordCleanupFailure(cause);
    }
    releaseRegistry();
  };

  try {
    session = await executor.launchSession({ session: undefined, video, traced: false }, attemptId, artifacts.dir, signal);
    session.appLog.route((entry, at) => steps.recordAppLog(entry, at));
  } catch (cause) {
    await executor.dispose();
    await teardownProcesses();
    throw cause;
  }

  const attemptEnd = new AbortController();
  const attempt: ExecutorAttempt = {
    testId: `session:${target.name}`,
    attemptId,
    index: 0,
    signal: attemptEnd.signal,
    memory: new Map<string, unknown>(),
  };
  const budget = new AttemptBudget(signal, new Deadline(options.timeoutMs));
  const { fixtures, agentRuntime } = createFixtures({
    config,
    target,
    session,
    steps,
    budget,
    runId,
    attemptId,
    attempt,
    artifacts: artifacts.sink,
    priorSteps: () => steps.completed(),
    agent: options.agent,
    agentContext: undefined,
    saveSession: undefined,
    // A model preflight failure is a run abort in a test; here it is one more
    // reason the attempt reports at close.
    models: new WorkerModels((error) => cleanupErrors.push(serializeError(error))),
    debug,
  });

  let closing: Promise<readonly SerializedError[]> | undefined;
  return {
    runId,
    attemptId,
    fixtures,
    agentRuntime,
    session,
    steps,
    budget,
    artifactsDir: artifacts.dir,
    close: () => {
      closing ??= (async () => {
        attemptEnd.abort();
        const record: ClosingRecord = { status: 'passed', cleanup: 'complete' };
        try {
          await executor.closeSession(session, { attemptId, video }, record, artifacts.sink, cleanupErrors);
          await executor.dispose();
          cleanupErrors.push(...executor.collectedRunErrors().map((runError) => runError.error));
          await artifacts.settle();
        } finally {
          // Whatever the attempt's own close did, the app processes and every leased device go.
          await teardownProcesses();
        }
        return cleanupErrors;
      })();
      return closing;
    },
  };
}

/**
 * What the standalone attempt records: what the mode says a first
 * attempt does, since there is no retry loop. The attempt always closes as
 * passed, so a recording kept only on failure would be made and deleted, and
 * is not made at all.
 */
function sessionRecording(recording: ResolvedRecording): AttemptRecording | undefined {
  const planned = attemptRecording(recording, 0);
  return planned?.keep === 'on-failure' ? undefined : planned;
}
