/**
 * A standalone attempt: one engine session on one target, with the full
 * fixture graph, and no test body. This is what a dev-loop host (`e2e mcp`)
 * opens so a coding agent can drive the live app through the same `agent`,
 * `screen`, and `app` surfaces a test would, under the same launch budgets,
 * origin policy, secret handling, and cleanup as a test attempt. The runner
 * proper (`execute.ts`) keeps owning retries, sessions, and records; this
 * module only borrows its session lifecycle.
 */

import path from 'node:path';
import type { ExecutorAttempt } from '../agent/executor.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { TargetSession } from '../engine/surface.ts';
import { DebugTrace } from '../internal/debug.ts';
import { classifyError, serializeError, type SerializedError } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { Deadline } from '../internal/time.ts';
import type { TestFixtures } from '../types.ts';
import { createAttemptArtifacts } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { TargetExecutor, type ClosingRecord } from './execute.ts';
import { createFixtures } from './fixtures.ts';
import { prepareEngines, startDeclaredProcesses, validateEngine, type AppProcesses } from './provision.ts';
import { SessionStore } from './sessions.ts';
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
  /** Where artifacts land, normally `<projectRoot>/.e2e/artifacts`. */
  readonly artifactsRoot: string;
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
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  /** The attempt's signal and deadline, for a host that drives the session directly. */
  readonly budget: AttemptBudget;
  /** Absolute artifact directory of this attempt. */
  readonly artifactsDir: string;
  /**
   * Ends the attempt: stops any trace, closes the session, disposes the
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

  validateEngine(target, config);
  await prepareEngines([target], { runId, env: options.env, signal }, notice);
  const processes: AppProcesses = await startDeclaredProcesses(
    [target],
    config.projectRoot,
    { ci: config.ci, notice: (message) => notice('app', message) },
    signal,
    debug,
  );

  const sessionStore = SessionStore.create(runId, path.join(config.projectRoot, '.e2e', 'sessions'));
  const executor = new TargetExecutor({
    config,
    target,
    runId,
    artifactsRoot: options.artifactsRoot,
    sessionStore,
    headed: options.headed,
    workerSlot: 0,
    isolated: false,
    interruptSignal: signal,
    debug,
    ...(options.onProgress === undefined ? {} : { events: { onProgress: (_testId, progress) => options.onProgress?.(progress) } }),
  });
  const steps = new StepRecorder(attemptId, {
    maxEventsPerStep: config.limits.maxEventsPerStep,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const artifacts = createAttemptArtifacts({
    artifactsRoot: options.artifactsRoot,
    segments: [target.name, 'sessions', attemptId],
    attemptId,
    currentStepId: () => steps.currentStepId,
    ...(config.artifactStore === undefined ? {} : { store: config.artifactStore }),
    identity: { runId, testId: `session:${target.name}`, attemptId },
  });

  const cleanupErrors: SerializedError[] = [];
  const recordCleanupFailure = (cause: unknown): void => {
    cleanupErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
  };
  const teardownProcesses = async (): Promise<void> => {
    await processes.stop(recordCleanupFailure);
    try {
      sessionStore.cleanup();
    } catch (cause) {
      recordCleanupFailure(cause);
    }
  };

  let session: TargetSession;
  try {
    session = await executor.launchSession(undefined, attemptId, artifacts.dir, signal);
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
  const fixtures = createFixtures({
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
    session,
    steps,
    budget,
    artifactsDir: artifacts.dir,
    close: () => {
      closing ??= (async () => {
        attemptEnd.abort();
        const record: ClosingRecord = { status: 'passed', cleanup: 'complete' };
        await executor.closeSession(session, attemptId, record, artifacts.sink, cleanupErrors);
        await executor.dispose();
        cleanupErrors.push(...executor.collectedRunErrors().map((runError) => runError.error));
        await artifacts.settle();
        await teardownProcesses();
        return cleanupErrors;
      })();
      return closing;
    },
  };
}
