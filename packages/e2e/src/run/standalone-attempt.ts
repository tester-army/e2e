/**
 * One attempt on a prepared standalone worker: reservation, launch, fixtures,
 * deadline, and close. What differs by kind (the runner's hosted and one-shot
 * attempts) comes in through `AttemptPolicy`.
 */

import path from 'node:path';
import type { ExecutorAttempt } from '../agent/executor.ts';
import type { AgentContext } from '../agent/invocation.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { TargetSession } from '../engine/surface.ts';
import { PollScope } from '../expect/poll-scope.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { classifyError, ConfigurationError, InfrastructureError, serializeError, TestTimeoutError, type SerializedError } from '../internal/errors.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, MAX_TIMER_MS, withTimeout } from '../internal/time.ts';
import { attemptVideo } from '../internal/recording-modes.ts';
import type { TestFixtures } from '../types.ts';
import { createAttemptArtifacts, type AttemptArtifacts } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { classifyAttemptStatus, type ClosingRecord, type EngineSessions } from './engine-sessions.ts';
import { createFixtures, type AttemptEnvironment } from './fixtures.ts';
import type { AttemptRecord } from './records.ts';
import { redactForSession, sessionLedger } from './secrecy.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import { WorkerModels } from './worker-models.ts';

export interface StandaloneSessionOptions {
  readonly signal: AbortSignal;
  /** Operation deadline from launch, positive and finite. */
  readonly timeoutMs: number;
  readonly agent?: string | undefined;
  readonly onProgress?: (progress: StepProgress) => void;
  /** The test title of a hosted attempt; its policy decides whether the attempt reads it. */
  readonly name?: string;
}

export interface StandaloneAttempt<Extra = unknown> {
  readonly runId: string;
  readonly attemptId: string;
  readonly fixtures: TestFixtures;
  readonly agentRuntime: AgentContext;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly budget: AttemptBudget;
  readonly artifactsDir: string;
  readonly tracePath: string;
  /** What the policy's `launched` built on the attempt. */
  readonly extra: Extra;
  close(): Promise<readonly SerializedError[]>;
}

/** Where an attempt's results go, and the test id its records carry. */
export interface AttemptIdentity {
  readonly testId: string;
  /** Directory segments under the results root. */
  readonly segments: readonly string[];
}

/** What a policy's `reserve` publishes for the attempt, withdrawn by `release`. */
export interface AttemptPublication {
  /** Failures the publication holds at close, such as soft assertions; called once. */
  close(): unknown;
  release(): void;
}

/** What a policy's `launched` reads of the open attempt. */
export interface LaunchedAttempt<Sessions extends EngineSessions> {
  readonly worker: AttemptWorker<Sessions>;
  readonly attemptId: string;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly artifacts: AttemptArtifacts;
  /** The inputs the attempt's own fixtures were built from, for fixtures of another budget. */
  readonly fixtureBase: Omit<AttemptEnvironment, 'budget' | 'agentContext'>;
  /** The worker's, the caller's, and the attempt's own cancellation together. */
  readonly signal: AbortSignal;
  readonly redact: (text: string) => string;
}

/** What a policy's `closed` reads once the attempt's session is closed. */
export interface ClosedAttempt<Sessions extends EngineSessions, Extra> {
  readonly worker: AttemptWorker<Sessions>;
  /** What `launched` returned. */
  readonly extra: Extra;
  readonly identity: AttemptIdentity;
  readonly agent: string;
  readonly options: StandaloneSessionOptions;
  readonly tracePath: string;
  readonly redact: (text: string) => string;
  readonly record: Omit<AttemptRecord, 'index' | 'trace'>;
}

/**
 * What one kind of attempt adds to the shared lifecycle. Every hook but
 * `identity` is optional, so a kind that publishes nothing, runs no test, and
 * writes no trace needs none of them.
 */
export interface AttemptPolicy<Sessions extends EngineSessions = EngineSessions, Extra = undefined> {
  /** The attempt's test id and results directory. */
  identity(worker: AttemptWorker<Sessions>, attemptId: string, agent: string, redactedName: string): AttemptIdentity;
  /** Runs synchronously at reservation, before any engine work, so nothing can publish over it. */
  reserve?(worker: AttemptWorker<Sessions>, reserved: { readonly attemptId: string; readonly budget: AttemptBudget; readonly polls: PollScope }): AttemptPublication;
  /** Runs once the attempt's fixtures exist; a throw closes the attempt and fails the launch. */
  launched?(attempt: LaunchedAttempt<Sessions>): Extra;
  /** Runs once the session is closed and its artifacts settled; a throw is a cleanup failure. */
  closed?(attempt: ClosedAttempt<Sessions, Extra>): Promise<void>;
}

/** The prepared worker an attempt runs on. */
export interface AttemptWorker<Sessions extends EngineSessions = EngineSessions> {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly executor: Sessions;
  readonly resultsDir: string;
  readonly debug: DebugTrace;
  /** Aborts when the host closes or its caller cancels it. */
  readonly signal: AbortSignal;
}

/** What `reserveAttempt` holds before any engine work: ids, budget, and the published expectations. */
export interface AttemptReservation {
  readonly attemptId: string;
  readonly options: StandaloneSessionOptions;
  /** Aborts the attempt's own operations; the attempt ends it at close. */
  readonly end: AbortController;
  /** The worker's, the caller's, and the attempt's own cancellation together. */
  readonly signal: AbortSignal;
  readonly budget: AttemptBudget;
  readonly polls: PollScope;
  readonly publication: AttemptPublication | undefined;
}

/** What the host learns when an attempt's close settles. */
export interface AttemptClosed {
  readonly cleanup: AttemptRecord['cleanup'];
}

/**
 * Validates the options and runs the policy's `reserve`, synchronously, so
 * what it publishes is there before launch and no second attempt can publish
 * over it.
 */
export function reserveAttempt<Sessions extends EngineSessions, Extra>(
  worker: AttemptWorker<Sessions>,
  policy: AttemptPolicy<Sessions, Extra>,
  options: StandaloneSessionOptions,
): AttemptReservation {
  if (worker.signal.aborted || options.signal.aborted) throw new InfrastructureError('CANCELLED', 'opening the e2e session was cancelled');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'session timeout must be a positive, finite number of milliseconds');
  }
  const attemptId = uuidv7();
  const end = new AbortController();
  const signal = AbortSignal.any([worker.signal, options.signal, end.signal]);
  const budget = new AttemptBudget(signal, new Deadline(options.timeoutMs));
  const polls = new PollScope('the hosted session');
  const publication = policy.reserve?.(worker, { attemptId, budget, polls });
  return { attemptId, options, end, signal, budget, polls, publication };
}

/**
 * Launches the reserved attempt and hands back its fixtures. A launch that
 * fails has already ended what it opened, the same as a run's retry relies
 * on; the worker stays usable. `onClosed` runs once when `close` settles,
 * before `close` returns, so the host can retire a worker whose cleanup failed.
 */
export async function launchAttempt<Sessions extends EngineSessions, Extra>(
  worker: AttemptWorker<Sessions>,
  policy: AttemptPolicy<Sessions, Extra>,
  reservation: AttemptReservation,
  onClosed: (closed: AttemptClosed) => Promise<void>,
): Promise<StandaloneAttempt<Extra>> {
  const { config, target, executor, runId } = worker;
  const { attemptId, options, budget, polls, end } = reservation;
  const attemptSignal = reservation.signal;
  let session: TargetSession | undefined;
  const redact = (text: string): string => redactForSession(session, config.allSecrets, text);
  const agent = options.agent ?? config.agentNames[0] ?? '';
  const identity = policy.identity(worker, attemptId, agent, redact(options.name ?? target.name));
  const steps = new StepRecorder(attemptId, {
    maxEventsPerStep: config.limits.maxEventsPerStep, projectRoot: config.projectRoot, redact, signal: attemptSignal,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const artifacts = createAttemptArtifacts({
    artifactsRoot: worker.resultsDir, segments: identity.segments, attemptId, currentStepId: () => steps.currentStepId,
    ...(config.artifactStore === undefined ? {} : { store: config.artifactStore }),
    ledger: () => session === undefined ? undefined : sessionLedger(session, config.allSecrets),
    identity: { runId, testId: identity.testId, attemptId },
  });
  const attemptErrors: SerializedError[] = [];
  const recordFailure = (cause: unknown, phase: 'body' | 'cleanup'): void => {
    attemptErrors.push(serializeError(classifyError(cause), { phase, projectRoot: config.projectRoot, redact }));
  };
  /** One outcome drives recording retention and the trace. */
  const verdict = (): { status: AttemptRecord['status']; error: SerializedError | undefined } => {
    const step = steps.all().find((candidate) => candidate.status !== 'passed');
    const error = attemptErrors[0] ?? step?.error;
    if (error === undefined) return { status: 'passed', error };
    return { status: classifyAttemptStatus(error, step?.status === 'timed-out', error.code === 'CANCELLED'), error };
  };
  const video = attemptVideo(target.video, 0);
  session = await executor.launchSession({ session: undefined, recordings: { trace: undefined, video } }, attemptId, artifacts.dir, attemptSignal);
  const opened = session;
  const closeOpened = (record: ClosingRecord): Promise<void> =>
    executor.closeSession(opened, { attemptId, video }, record, artifacts.sink, attemptErrors);
  if (attemptSignal.aborted) {
    await closeOpened({ status: 'interrupted', cleanup: 'complete' });
    throw new InfrastructureError('CANCELLED', 'opening the e2e session was cancelled');
  }
  opened.appLog.route((event, at) => steps.recordAppEvent(event, at));
  // Launch was the worker's work; the test's deadline starts once its fixtures exist.
  budget.enter(attemptSignal, options.timeoutMs);
  const attempt: ExecutorAttempt = { testId: identity.testId, attemptId, titlePath: [], index: 0, signal: end.signal, memory: new Map<string, unknown>() };
  const base = {
    config, target, session: opened, steps, runId, attemptId, attempt, artifacts: artifacts.sink,
    priorSteps: () => steps.completed(), agent: options.agent, saveSession: undefined,
    models: new WorkerModels((error) => recordFailure(error, 'body')), debug: worker.debug,
  };
  let acquired: ReturnType<typeof createFixtures>;
  let extra: Extra;
  try {
    acquired = createFixtures({ ...base, budget, agentContext: undefined });
    extra = policy.launched === undefined
      ? undefined as Extra
      : policy.launched({ worker, attemptId, session: opened, steps, artifacts, fixtureBase: base, signal: attemptSignal, redact });
  } catch (cause) {
    end.abort();
    await closeOpened({ status: 'failed', cleanup: 'complete' });
    throw cause;
  }
  const { deadline } = budget;
  let timedOut = false;
  /** Fails the attempt as timed out, once, and cuts whatever is still in flight. */
  const expire = (): void => {
    if (timedOut) return;
    timedOut = true;
    const timeout = new TestTimeoutError(`session timed out after ${options.timeoutMs} ms`);
    recordFailure(timeout, 'body');
    end.abort(timeout);
  };
  // An engine that ignores its operation's timeout, or a model call, must not
  // outlive the deadline: the attempt is cut the way a run's body is. One
  // tick after it, so an operation that honors the deadline reports its own
  // failure first; whatever is still in flight then fails as timed out.
  const remaining = deadline.remaining() + 1;
  const expiry = remaining > MAX_TIMER_MS ? undefined : setTimeout(expire, remaining);
  expiry?.unref();
  const startedAt = timestamp();
  const startedMs = Date.now();
  const tracePath = path.join(artifacts.dir, 'trace.md');
  let ending: Promise<readonly SerializedError[]> | undefined;
  const close = (): Promise<readonly SerializedError[]> => {
    ending ??= (async () => {
      clearTimeout(expiry);
      // The deadline decides the outcome, not whether the timer ran before close.
      if (deadline.expired()) expire();
      const abandonedPoll = polls.close();
      const abandonedStep = steps.abandonRunning();
      end.abort();
      for (const error of [abandonedStep, abandonedPoll, reservation.publication?.close()]) if (error !== undefined) recordFailure(error, 'body');
      try {
        await withTimeout(steps.settleAbandoned(), config.cleanupTimeout, () => new InfrastructureError('CLEANUP_TIMEOUT', 'abandoned session steps did not settle'));
      } catch (cause) { recordFailure(cause, 'cleanup'); }
      try {
        // Settling runs under the worker's signal; an interrupted host still ends its attempt below.
        if (!worker.signal.aborted) await executor.settleAttempt(opened, attemptId);
      } catch (cause) { recordFailure(cause, 'body'); }
      const record: ClosingRecord = { status: verdict().status, cleanup: 'complete' };
      try {
        await closeOpened(record);
      } catch (cause) { recordFailure(cause, 'cleanup'); record.cleanup = 'failed'; }
      try { await artifacts.settle(); } catch (cause) { recordFailure(cause, 'cleanup'); }
      if (policy.closed !== undefined) {
        try {
          const { error, status } = verdict();
          await policy.closed({
            worker, extra, identity, agent, options, tracePath, redact,
            record: {
              id: attemptId, status, startedAt, durationMs: Date.now() - startedMs,
              steps: [...steps.all()], appLog: [...steps.appLog()], artifacts: artifacts.records,
              ...(error === undefined ? {} : { error }), secondaryErrors: attemptErrors.slice(1), cleanup: record.cleanup,
            },
          });
        } catch (cause) { recordFailure(cause, 'cleanup'); }
      }
      try {
        await onClosed({ cleanup: record.cleanup });
      } finally {
        reservation.publication?.release();
      }
      return attemptErrors;
    })();
    return ending;
  };
  return {
    runId, attemptId, fixtures: acquired.fixtures, agentRuntime: acquired.agentRuntime, session: opened, steps, budget,
    artifactsDir: artifacts.dir, tracePath, extra, close,
  };
}
