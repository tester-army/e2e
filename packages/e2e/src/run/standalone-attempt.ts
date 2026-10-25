/** One attempt on a prepared standalone worker: reservation, launch, fixtures, deadline, and close. */

import path from 'node:path';
import type { ExecutorAttempt } from '../agent/executor.ts';
import type { AgentContext } from '../agent/invocation.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { TargetSession } from '../engine/surface.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { PollScope } from '../expect/poll-scope.ts';
import { SoftFailures } from '../expect/soft.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { classifyError, ConfigurationError, InfrastructureError, serializeError, TestTimeoutError, type SerializedError } from '../internal/errors.ts';
import { resultId, timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, MAX_TIMER_MS, withTimeout } from '../internal/time.ts';
import { attemptVideo } from '../internal/recording-modes.ts';
import type { Report, TestFixtures } from '../types.ts';
import { createAttemptArtifacts, resultSegment } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { classifyAttemptStatus, type ClosingRecord, type TargetExecutor } from './execute.ts';
import { createFixtures } from './fixtures.ts';
import { writeHostTrace } from './host-trace.ts';
import type { AttemptRecord } from './records.ts';
import { holdSecretRegistry } from '../secrets.ts';
import { processSecrets, redactForSession, sessionSecrecy } from './secrecy.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import { WorkerModels } from './worker-models.ts';

/**
 * Who drives the attempt. A hosted attempt is a test in another runner: it
 * publishes itself for `expect.soft` and `expect.poll`, enforces its deadline,
 * and writes a trace under `results/host/`. A one-shot attempt is `e2e mcp`'s
 * live session: no test body, no publication, artifacts under `results/mcp/`.
 */
export type AttemptKind = 'hosted' | 'one-shot';

export interface StandaloneSessionOptions {
  readonly signal: AbortSignal;
  /** Operation deadline from launch, positive and finite. */
  readonly timeoutMs: number;
  readonly agent?: string | undefined;
  readonly onProgress?: (progress: StepProgress) => void;
  /** The test title of a hosted attempt; ignored by a one-shot attempt. */
  readonly name?: string;
}

export interface StandaloneAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly fixtures: TestFixtures;
  readonly agentRuntime: AgentContext;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly budget: AttemptBudget;
  readonly artifactsDir: string;
  readonly tracePath: string;
  report(): Report | undefined;
  close(): Promise<readonly SerializedError[]>;
}

/** The prepared worker an attempt runs on. */
export interface AttemptWorker {
  readonly kind: AttemptKind;
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly executor: TargetExecutor;
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
  readonly soft: SoftFailures;
  readonly polls: PollScope;
  /** Withdraws the publication and the registry hold once cleanup has settled. */
  readonly release: () => void;
}

/** What the host learns when an attempt's close settles. */
export interface AttemptClosed {
  readonly cleanup: AttemptRecord['cleanup'];
}

/**
 * Validates the options and publishes a hosted attempt, synchronously, so
 * `expect` finds it before launch and no second attempt can publish over it.
 */
export function reserveAttempt(worker: AttemptWorker, options: StandaloneSessionOptions): AttemptReservation {
  if (worker.signal.aborted || options.signal.aborted) throw new InfrastructureError('CANCELLED', 'opening the e2e session was cancelled');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'session timeout must be a positive, finite number of milliseconds');
  }
  const attemptId = uuidv7();
  const end = new AbortController();
  const signal = AbortSignal.any([worker.signal, options.signal, end.signal]);
  const budget = new AttemptBudget(signal, new Deadline(options.timeoutMs));
  const soft = new SoftFailures();
  const polls = new PollScope('the hosted session');
  if (worker.kind === 'one-shot') return { attemptId, options, end, signal, budget, soft, polls, release: () => undefined };
  const { config } = worker;
  const publication = new AbortController();
  publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls }, publication.signal);
  // The live attempt's secrets resolve against its own config while other hosts hold theirs.
  const releaseRegistry = holdSecretRegistry(config, { live: true });
  return { attemptId, options, end, signal, budget, soft, polls, release: () => { publication.abort(); releaseRegistry(); } };
}

/**
 * Launches the reserved attempt and hands back its fixtures. A launch that
 * fails has already ended what it opened, the same as a run's retry relies
 * on; the worker stays usable. `onClosed` runs once when `close` settles,
 * before `close` returns, so the host can retire a worker whose cleanup failed.
 */
export async function launchAttempt(
  worker: AttemptWorker,
  reservation: AttemptReservation,
  onClosed: (closed: AttemptClosed) => Promise<void>,
): Promise<StandaloneAttempt> {
  const { config, target, executor, runId } = worker;
  const { attemptId, options, budget, soft, polls, end } = reservation;
  const attemptSignal = reservation.signal;
  let session: TargetSession | undefined;
  const redact = (text: string): string => redactForSession(session, config.allSecrets, text);
  const agent = options.agent ?? config.agentNames[0] ?? '';
  const identity = attemptIdentity(worker, attemptId, agent, redact(options.name ?? target.name));
  const steps = new StepRecorder(attemptId, {
    maxEventsPerStep: config.limits.maxEventsPerStep, projectRoot: config.projectRoot, redact, signal: attemptSignal,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  const artifacts = createAttemptArtifacts({
    artifactsRoot: worker.resultsDir, segments: identity.segments, attemptId, currentStepId: () => steps.currentStepId,
    ...(config.artifactStore === undefined ? {} : { store: config.artifactStore }),
    secrecy: () => session === undefined ? undefined : sessionSecrecy(session, config.allSecrets),
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
  let acquired: ReturnType<typeof createFixtures>;
  try {
    acquired = createFixtures({
      config, target, session: opened, steps, budget, runId, attemptId, attempt, artifacts: artifacts.sink,
      priorSteps: () => steps.completed(), agent: options.agent, agentContext: undefined, saveSession: undefined,
      models: new WorkerModels((error) => recordFailure(error, 'body')), debug: worker.debug,
    });
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
  let report: Report | undefined;
  const close = (): Promise<readonly SerializedError[]> => {
    ending ??= (async () => {
      clearTimeout(expiry);
      // The deadline decides the outcome, not whether the timer ran before close.
      if (deadline.expired()) expire();
      const abandonedPoll = polls.close();
      const abandonedStep = steps.abandonRunning();
      end.abort();
      for (const error of [abandonedStep, abandonedPoll, soft.close()]) if (error !== undefined) recordFailure(error, 'body');
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
      if (worker.kind === 'hosted') {
        try {
          const { error, status } = verdict();
          report = await writeHostTrace({
            config, target, runId, testId: identity.testId, agent, tracePath, redact,
            title: processSecrets.redact(redact(options.name ?? target.name)),
            resultsDir: worker.resultsDir, segments: identity.segments,
            attempt: {
              id: attemptId, index: 0, status, startedAt, durationMs: Date.now() - startedMs,
              steps: [...steps.all()], appLog: [...steps.appLog()], artifacts: artifacts.records,
              ...(error === undefined ? {} : { error }), secondaryErrors: attemptErrors.slice(1), cleanup: record.cleanup,
            },
          });
        } catch (cause) { recordFailure(cause, 'cleanup'); }
      }
      try {
        await onClosed({ cleanup: record.cleanup });
      } finally {
        reservation.release();
      }
      return attemptErrors;
    })();
    return ending;
  };
  return {
    runId, attemptId, fixtures: acquired.fixtures, agentRuntime: acquired.agentRuntime, session: opened, steps, budget,
    artifactsDir: artifacts.dir, tracePath, close,
    report: () => report && structuredClone(report),
  };
}

interface AttemptIdentity {
  readonly testId: string;
  /** Directory segments under the results root. */
  readonly segments: readonly string[];
}

/**
 * A hosted attempt's directory is `host/<file>-<title>-<digest>`: the digest
 * covers the unique attempt id, so repeated names never share a directory,
 * and the title slug is dropped while a provider's values are unknown, since
 * no caller text can then be vouched for as a path. A one-shot attempt keeps
 * `mcp/<target>-<attemptId>`.
 */
function attemptIdentity(worker: AttemptWorker, attemptId: string, agent: string, redactedName: string): AttemptIdentity {
  const { kind, target, config } = worker;
  if (kind === 'one-shot') return { testId: `session:${target.name}`, segments: ['mcp', `${target.name}-${attemptId}`] };
  const testId = `host:${attemptId}`;
  const providerSecrets = [...config.allSecrets.values()].some((secret) => typeof secret.value === 'function');
  const title = providerSecrets ? 'session' : processSecrets.redact(redactedName);
  const segment = resultSegment({ id: resultId(testId, target.name, agent, 0), file: 'host', titlePath: [title] });
  return { testId, segments: ['host', segment] };
}
