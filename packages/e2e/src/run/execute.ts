/** Test-target execution engine. */

import path from 'node:path';
import type { TargetSession } from '../engine/surface.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import { classifyError, ConfigurationError, E2EError, serializeError, sanitizeText, truncateUtf8, TestError, TestTimeoutError, type SerializedError } from '../internal/errors.ts';
import { isRuntimeSkip, type RuntimeSkip } from '../internal/skip.ts';
import { lateExpectedFailureError } from '../internal/expected-failure.ts';
import { settleExpectedFailure } from './expected-failure.ts';
import type { ExecutorAttempt } from '../agent/executor.ts';
import { isModelUnreachable } from '../agent/error.ts';
import { withAiTraceScope } from '../internal/ai-trace.ts';
import { resultId, timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, withAbort, withTimeout } from '../internal/time.ts';
import { createAgentCacheContext, settleStagedTraces } from '../cache/context.ts';
import { storedRecordingsFor, type StoredRecordings } from '../cache/rekeyed.ts';
import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import { pairRecordings, type TestTargetPair } from '../collect/select.ts';
import type { ArtifactStore } from '../types.ts';
import { attemptSegments, createAttemptArtifacts, resultSegment } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { createExtendedFixtures } from './extended-fixtures.ts';
import { captureFailureEvidence } from './failure-evidence.ts';
import { createFixtures } from './fixtures.ts';
import { WrittenScreenshots } from './screenshots.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { PollScope, runInPollScope } from '../expect/poll-scope.ts';
import { SoftFailures } from '../expect/soft.ts';
import { findRegistered, RealmManager, runHook, type FileRef, type Realm } from './realm.ts';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  RunError,
  SerialGroupRecord,
  SerialMemberRecord,
} from './records.ts';
import { isFailedStatus, type SerialAttemptRecord } from './records.ts';
import { traceScreen } from './step-screens.ts';
import { runWithRetries } from './retry.ts';
import { runSerialUnit, type SerialAttemptStart, type SerialHost, type SharedSerialSession } from './serial.ts';
import { interruptedInPhase, interruptedSkip, pairKey, pairResult, unstartedResult } from './units.ts';
import { carriedSecrets, processSecrets, redactForSession, sessionLedger, staticSecretLedger } from './secrecy.ts';
import { SessionStaging } from './sessions.ts';
import { StepRecorder, type StepHoldRequest, type StepProgress } from './steps.ts';
import { AttemptHolds, type HeldStep } from './step-hold.ts';
import { WorkerModels } from './worker-models.ts';
import { classifyAttemptStatus, EngineSessions, type EngineSessionsOptions } from './engine-sessions.ts';
import type { SetupFn } from '../types.ts';

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
  onSerialGroup?(group: SerialGroupRecord): void;
  /** An attempt of an ordinary or setup pair begins, its realm and `beforeAll` hooks included. */
  onAttemptStart?(pair: TestTargetPair, attemptIndex: number): void;
  /** One finished attempt of an ordinary or setup pair, ahead of the pair's result. */
  onAttempt?(pair: TestTargetPair, attempt: AttemptRecord): void;
  /** One member that finished in a serial group attempt, ahead of the group. */
  onSerialMember?(groupId: string, attempt: SerialAttemptStart, member: SerialMemberRecord): void;
  /** One finished serial group attempt, ahead of the group. */
  onSerialAttempt?(groupId: string, attempt: SerialAttemptRecord): void;
  /** Fires before a runnable pair starts; a serial unit announces each member as it begins. */
  onPairStart?(pair: TestTargetPair): void;
  /** Live step progress of one running attempt, for reporters. */
  onProgress?(pair: TestTargetPair, progress: StepProgress): void;
  /**
   * An attempt's test timeout started, as its `beforeEach` hooks and body
   * begin; again with `remainingMs` each time its test clock runs again
   * after `e2e run --step` held a step.
   */
  onAttemptDeadline?(
    pair: TestTargetPair,
    attempt: { readonly index: number; readonly id: string; readonly startedAt: string; readonly remainingMs?: number },
  ): void;
  /** The attempt `onAttemptDeadline` announced has ended, or one that never got that far has. */
  onAttemptEnd?(): void;
  /** One line of progress the engine's `init` reported, already naming the target and worker slot. */
  onNotice?(message: string): void;
  /**
   * A run-level configuration failure met mid-run, such as an unusable model
   * on the first `agent` acquisition. The run should stop; the error is
   * recorded once for the run, not against the test that met it.
   */
  onRunAbort?(error: RunError): void;
}

export interface TargetExecutorOptions extends EngineSessionsOptions {
  readonly artifactsRoot: string;
  /**
   * The directory under `artifactsRoot` a `--last-failed` rerun's attempts
   * write in (`claimRerunDir`), beside the evidence of the run it reruns;
   * undefined when the attempts fill the root themselves.
   */
  readonly rerunDir?: string | undefined;
  /**
   * Whether this executor runs in a process of its own that ends with its
   * work. Only then can an interrupted test body be abandoned mid-flight:
   * the process takes it down. In the runner's own process (a `rawConfig`
   * run) the body would keep executing after the run resolved, so there the
   * interrupt waits for it to reach a harness call or its timeout.
   */
  readonly isolated: boolean;
  /**
   * Holds each top-level step of a test's first attempt until the runner
   * lets it run (`e2e run --step`); it resolves to run the step. Setup tests
   * and retries never wait.
   */
  readonly holdStep?: ((step: HeldStep, signal: AbortSignal) => Promise<void>) | undefined;
  readonly events?: ExecutionEvents;
  /** The virtual file of tests registered in memory, and the agents they run as; see `InMemoryAttempts`. */
  readonly inMemory?: InMemoryAttempts | undefined;
}

/**
 * How the attempts of tests registered in memory (`e2e explore`) differ from
 * the rest of the run: they run as `agents` in place of the config's, when
 * given, and with the trace cache off, since nothing replays a test that has
 * no source. The setup tests they need run with the config's own.
 */
export interface InMemoryAttempts {
  readonly file: string;
  readonly agents?: ResolvedConfig['agents'] | undefined;
}

type AttemptPhase = 'launch' | 'beforeEach' | 'body' | 'afterEach';

/** How one attempt acquires its session and session-staging hooks. */
export type AttemptContext =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'setup'; readonly staging: SessionStaging }
  | { readonly kind: 'serial'; readonly shared: SharedSerialSession };

/** Executes every selected pair for one target sequentially. */
export class TargetExecutor extends EngineSessions implements SerialHost {
  get artifactStore(): ArtifactStore | undefined {
    return this.config.artifactStore;
  }
  readonly artifactsRoot: string;
  readonly rerunDir: string | undefined;
  readonly realms: RealmManager;

  /** Fails the attempt in flight from outside it, while one is; see `strayRejection`. */
  private strayFailure: ((cause: unknown) => void) | undefined;
  /** The last test whose attempt ended here: the likely source of a rejection that surfaces between attempts. */
  private lastAttemptTestId: string | undefined;
  private readonly models: WorkerModels;
  /** The file store's listing under `cache.strict`, read once for every attempt here. */
  private readonly storedRecordings: StoredRecordings | undefined;
  /** The stored screenshots the run wrote, so no comparison passes against one nobody reviewed. */
  private readonly writtenScreenshots: WrittenScreenshots;

  constructor(protected override readonly options: TargetExecutorOptions) {
    super(options);
    this.artifactsRoot = options.artifactsRoot;
    this.writtenScreenshots = new WrittenScreenshots(options.artifactsRoot);
    this.rerunDir = options.rerunDir;
    this.models = new WorkerModels((error) => {
      options.events?.onRunAbort?.({ error: serializeError(error) });
    });
    this.realms = new RealmManager({
      targetName: options.target.name,
      platform: options.target.platform,
      timeout: options.config.timeout,
      cleanupTimeout: options.config.cleanupTimeout,
      runErrors: this.runErrors,
      redactTitle: staticSecretLedger(options.config.allSecrets).redact,
      debug: this.debug,
    });
    this.storedRecordings = storedRecordingsFor(options.config.cache);
  }

  /** Emits one final result record (SerialHost). Records are not retained. */
  emit(result: ResultRecord): void {
    this.options.events?.onResult?.(result);
  }

  /** Announces one pair about to execute (SerialHost). */
  pairStarted(pair: TestTargetPair): void {
    this.options.events?.onPairStart?.(pair);
  }

  /** Emits one finished serial group, ahead of its members' results (SerialHost). */
  emitSerialGroup(group: SerialGroupRecord): void {
    this.options.events?.onSerialGroup?.(group);
  }

  /** Streams one member finished in a serial group attempt (SerialHost). */
  serialMemberFinished(groupId: string, attempt: SerialAttemptStart, member: SerialMemberRecord): void {
    this.options.events?.onSerialMember?.(groupId, attempt, member);
  }

  /** Streams one finished serial group attempt (SerialHost). */
  serialAttemptFinished(groupId: string, attempt: SerialAttemptRecord): void {
    this.options.events?.onSerialAttempt?.(groupId, attempt);
  }


  /**
   * Takes a rejection nobody in this process caught: a promise a test started
   * and never awaited. Node cannot say which test created it, so it is
   * charged to the attempt in flight: a running body is cut short the way a
   * timeout cuts it, a body that already returned has it recorded against the
   * phase it landed in. Between attempts it becomes a run error naming the
   * last test that finished here, the likely source. False before any test
   * has finished, when nothing can be named and the rejection is the
   * process's own.
   */
  strayRejection(cause: unknown): boolean {
    const fail = this.strayFailure;
    if (fail !== undefined) {
      fail(cause);
      return true;
    }
    const testId = this.lastAttemptTestId;
    if (testId === undefined) return false;
    const error = new TestError(
      'UNHANDLED_REJECTION',
      `a promise rejected between tests, most likely left by "${testId}", the last test to finish in this worker: ${classifyError(cause).message}`,
      { cause },
    );
    this.runErrors.push({
      error: serializeError(error, { projectRoot: this.config.projectRoot, redact: (text) => processSecrets.redact(text) }),
    });
    return true;
  }


  /**
   * Runs one file-target unit: runnable pairs of a single file, in declaration
   * order, sharing a realm between passing non-serial tests. Dispatch-time gating (selection dispositions and
   * setup-failure dependencies) belongs to the scheduler, so every pair
   * reaching here is runnable.
   */
  async runFileUnit(
    file: FileRef,
    filePairs: readonly TestTargetPair[],
    freshRegistration?: ModuleRegistration,
  ): Promise<void> {
    const executedSerialUnits = new Set<string>();
    const ordered = filePairs.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
    let realm: Realm | null =
      freshRegistration === undefined ? null : this.realms.adopt(freshRegistration, file);
    for (const [index, pair] of ordered.entries()) {
      // One serial unit per agent the group runs as: its members are the
      // group's pairs under that agent, in declaration order. The unit
      // reports every member when it runs, however it ended, so a later
      // member is done here before the interrupt is consulted; an interrupt
      // that landed during the group would otherwise report it twice.
      const serialUnitKey =
        pair.test.serialId === undefined ? undefined : pairKey(pair.test.serialId, pair.agent, pair.repeat);
      if (serialUnitKey !== undefined && executedSerialUnits.has(serialUnitKey)) continue;
      if (this.interruptSignal.aborted) {
        this.emit(unstartedResult(pair, interruptedSkip(this.interruptSignal)));
        continue;
      }
      if (serialUnitKey !== undefined) {
        executedSerialUnits.add(serialUnitKey);
        const members = ordered.filter(
          (member) => member.test.serialId === pair.test.serialId && member.agent === pair.agent && member.repeat === pair.repeat,
        );
        // A serial group owns its realm; whatever realm ordinary tests were
        // sharing ends here, afterAll included.
        if (realm !== null) await this.realms.leave(realm);
        realm = null;
        await runSerialUnit(this, members, file);
        continue;
      }
      this.pairStarted(pair);
      realm = await this.runOrdinaryPair(pair, file, realm);
      // A scope's afterAll runs as soon as its last test in this realm is
      // done, so a describe's teardown never lands after a sibling's tests.
      if (realm !== null) {
        const teardownFailure = await this.realms.leaveFinished(realm, ordered.slice(index + 1));
        if (teardownFailure !== undefined) {
          // An afterAll failure discards the suite
          // instance. Later tests start in a fresh realm rather than on
          // module state a failed teardown left behind; every scope whose
          // beforeAll started still tears down first.
          await this.realms.leave(realm);
          realm = null;
        }
      }
    }
    if (realm !== null) await this.realms.leave(realm);
  }

  /** Records a deterministic-registration violation as a run-level error. */
  recordDisappeared(message: string): void {
    this.runErrors.push({
      error: serializeError(new ConfigurationError('COLLECTION_ERROR', message), {
        phase: 'collection',
      }),
    });
  }

  // --- ordinary tests ---

  private async runOrdinaryPair(
    pair: TestTargetPair,
    file: FileRef,
    incomingRealm: Realm | null,
  ): Promise<Realm | null> {
    const attempts: AttemptRecord[] = [];
    let realm = incomingRealm;
    let hookFailure: SerializedError | undefined;

    const finalStatus = await runWithRetries(
      pair.options.retries + 1,
      this.interruptSignal,
      async (attemptIndex) => {
        this.options.events?.onAttemptStart?.(pair, attemptIndex);
        if (realm === null) realm = await this.realms.create(file);
        const registered = findRegistered(realm, pair.test);
        if (registered === undefined) {
          this.recordDisappeared(
            `test ${pair.test.id} disappeared on re-import; registration must be deterministic`,
          );
          return undefined;
        }
        hookFailure = await this.realms.enterScopes(realm, registered);
        if (hookFailure !== undefined) return undefined;
        const attempt = await this.runAttempt(pair, registered, realm, attemptIndex, {
          kind: 'ordinary',
        });
        attempts.push(attempt);
        this.options.events?.onAttempt?.(pair, attempt);
        if (isFailedStatus(attempt.status) || attempt.expectedFailure?.error !== undefined) {
          // A failed realm is never reused, but afterAll still runs for every
          // scope whose beforeAll started in it. A body that skipped itself
          // left the suite instance as it found it, so the next test keeps it;
          // one that failed as expected still failed.
          await this.realms.leave(realm);
          realm = null;
        }
        return attempt;
      },
    );

    this.emitUnitResult(pair, finalStatus, attempts, hookFailure);
    return realm;
  }

  /**
   * The result of a test or setup unit. A beforeAll failure before any
   * attempt ran skips the unit; on a retry the recorded attempts stand, since
   * the hook failure is already a run error and a failing test must not be
   * reported as skipped. A unit whose body skipped itself ends on its first
   * skipped attempt (`runWithRetries`), so that attempt's reason is the
   * result's.
   */
  private emitUnitResult(
    pair: TestTargetPair,
    finalStatus: ResultStatus,
    attempts: AttemptRecord[],
    hookFailure: SerializedError | undefined,
  ): void {
    if (hookFailure !== undefined && attempts.length === 0) {
      this.emit(
        pairResult(pair, {
          status: 'skipped',
          selected: true,
          skip: { cause: 'hook-failed', reason: hookFailure.message },
          attempts: [],
        }),
      );
      return;
    }
    const last = attempts.at(-1);
    this.emit(
      pairResult(pair, {
        status: finalStatus,
        selected: true,
        attempts,
        ...(last?.status === 'skipped' ? { skip: last.skip } : {}),
      }),
    );
  }

  // --- setup tests ---

  /** Runs one setup pair to completion, persisting staged sessions on success. */
  async runSetupUnit(pair: TestTargetPair, freshRegistration?: ModuleRegistration): Promise<void> {
    this.pairStarted(pair);
    const file: FileRef = { file: pair.test.file, absolutePath: path.resolve(this.config.projectRoot, pair.test.file) };
    const attempts: AttemptRecord[] = [];
    let hookFailure: SerializedError | undefined;

    const finalStatus = await runWithRetries(
      pair.options.retries + 1,
      this.interruptSignal,
      async (attemptIndex) => {
        this.options.events?.onAttemptStart?.(pair, attemptIndex);
        const realm =
          attemptIndex === 0 && freshRegistration !== undefined
            ? this.realms.adopt(freshRegistration, file)
            : await this.realms.create(file);
        const registered = findRegistered(realm, pair.test);
        if (registered === undefined) {
          this.recordDisappeared(`setup ${pair.test.id} disappeared on re-import`);
          return undefined;
        }
        hookFailure = await this.realms.enterScopes(realm, registered);
        if (hookFailure !== undefined) {
          await this.realms.leave(realm);
          return undefined;
        }
        const staging = new SessionStaging(pair.test.sessions);
        const attempt = await this.runAttempt(pair, registered, realm, attemptIndex, {
          kind: 'setup',
          staging,
        });
        const missing = attempt.status === 'passed' ? staging.missing() : [];
        if (missing.length > 0) {
          attempt.status = 'failed';
          attempt.error = serializeError(
            new E2EError(
              'test',
              'SESSION_CONTRACT',
              `setup must save each declared session exactly once; missing: [${missing.join(', ')}]`,
            ),
            { phase: 'body' },
          );
        }
        attempts.push(attempt);
        // Sent before teardown and the session saves, as in runOrdinaryPair:
        // a crash in either then lands on this attempt instead of erasing it.
        this.options.events?.onAttempt?.(pair, attempt);
        await this.realms.leave(realm);
        if (attempt.status === 'passed') {
          for (const [name, saved] of staging.entries()) {
            await this.options.sessionStore.save(name, this.sessionIdentity, saved);
          }
        }
        return attempt;
      },
    );

    this.emitUnitResult(pair, finalStatus, attempts, hookFailure);
  }


  /** Runs one attempt to completion (SerialHost). */
  /**
   * Runs one attempt under its AI trace scope, so every model call the
   * attempt makes is attributed to this test, target, and attempt.
   */
  runAttempt(
    pair: TestTargetPair,
    registered: RegisteredTest,
    realm: Realm,
    attemptIndex: number,
    context: AttemptContext,
  ): Promise<AttemptRecord> {
    return withAiTraceScope(
      {
        test: pair.test.titlePath.join(' › '),
        testId: pair.test.id,
        target: this.target.name,
        agent: pair.agent,
        attempt: attemptIndex,
      },
      async () => {
        try {
          return await this.executeAttempt(pair, registered, realm, attemptIndex, context);
        } finally {
          this.options.events?.onAttemptEnd?.();
        }
      },
    );
  }

  private async executeAttempt(
    pair: TestTargetPair,
    registered: RegisteredTest,
    realm: Realm,
    attemptIndex: number,
    context: AttemptContext,
  ): Promise<AttemptRecord> {
    const attemptId = uuidv7();
    const recordings = pairRecordings(pair, attemptIndex);
    const { trace, video } = recordings;
    const startedAt = timestamp();
    const startedMs = Date.now();
    // Serial members borrow the group's shared session, open state, artifact
    // directory, and prior-step context; every other attempt owns its own.
    const shared = context.kind === 'serial' ? context.shared : undefined;
    const onProgress = this.options.events?.onProgress;
    let openSession: TargetSession | null = null;
    // Secret values the session has seen never enter an error record or a
    // step label; the ledger is live, so a value resolved mid-attempt is
    // covered too. Before a session opens, the static values still are.
    const redact = (text: string): string => redactForSession(openSession ?? undefined, this.config.allSecrets, text);
    // Set once the test clock exists, before the first step that could wait.
    let holds: AttemptHolds | undefined;
    const holdStep = context.kind === 'setup' || attemptIndex > 0 ? undefined : this.options.holdStep;
    const steps = new StepRecorder(attemptId, {
      ...(holdStep === undefined ? {} : { hold: (step: StepHoldRequest, signal: AbortSignal) => holds?.hold(step, signal) ?? Promise.resolve() }),
      attempt: { id: shared?.attemptId ?? attemptId, index: attemptIndex },
      maxEventsPerStep: this.config.limits.maxEventsPerStep,
      projectRoot: this.config.projectRoot,
      redact,
      ...(onProgress === undefined
        ? {}
        : { onProgress: (progress: StepProgress) => onProgress(pair, progress) }),
    });
    // Agent prompts quote completed steps as prior context. Serial-group
    // members prepend the steps earlier members already contributed.
    const priorSteps =
      shared === undefined
        ? () => steps.completed()
        : () => [...shared.priorSteps, ...steps.completed()];
    const secondaryErrors: SerializedError[] = [];
    const attemptAbort = new AbortController();
    const onInterrupt = () => attemptAbort.abort();
    this.interruptSignal.addEventListener('abort', onInterrupt, { once: true });
    // Aborted in `finally`, so it fires once the attempt has ended on any path
    // and an executor holding per-attempt state has one signal to release it
    // on. Its own controller rather than `attemptAbort`, which only fires on
    // interrupt and timeout, and which the session still reads during
    // teardown. Serial members share the group's executor memory the way they
    // share its ledger.
    const attemptEnd = new AbortController();
    const attempt: ExecutorAttempt = {
      testId: pair.test.id,
      attemptId,
      titlePath: pair.test.titlePath,
      index: attemptIndex,
      signal: attemptEnd.signal,
      memory: shared?.memory ?? new Map<string, unknown>(),
    };

    const artifacts = createAttemptArtifacts({
      artifactsRoot: this.artifactsRoot,
      // Serial members share the group's session, and therefore its artifact
      // directory; registering under their own would not resolve on disk.
      segments:
        shared?.artifactSegments ??
        attemptSegments(
          this.rerunDir,
          resultSegment({ id: resultId(pair.test.id, this.target.name, pair.agent, pair.repeat), file: pair.test.file, titlePath: pair.test.titlePath }),
          attemptIndex,
        ),
      attemptId,
      currentStepId: () => steps.currentStepId,
      ...(this.config.artifactStore === undefined ? {} : { store: this.config.artifactStore }),
      ledger: () => (openSession === null ? undefined : sessionLedger(openSession, this.config.allSecrets)),
      // A serial member's artifacts are filed under the group attempt in the
      // report, so that is the attempt a store must see for them.
      identity: { runId: this.options.runId, testId: pair.test.id, attemptId: shared?.attemptId ?? attemptId },
    });

    const record: AttemptRecord = {
      id: attemptId,
      index: attemptIndex,
      status: 'passed',
      startedAt,
      durationMs: 0,
      steps: [],
      artifacts: artifacts.records,
      secondaryErrors,
      trace,
      cleanup: 'complete',
    };

    let failure: E2EError | undefined;
    let failurePhase: AttemptPhase | undefined;
    /** Set when the body (or a beforeEach) skipped the test with `test.skip(...)`. */
    let skipped: RuntimeSkip | undefined;
    /** Why the attempt is expected to fail: the `fail` option, else the first `test.fail(...)` that marked it. */
    let expectedFailure = pair.options.expectedFailure;
    let phase: AttemptPhase = 'launch';
    /** Moves the attempt to `next`, and the steps it records into the hook they run in (none for the body). */
    const enter = (next: AttemptPhase): void => {
      phase = next;
      steps.phase = next === 'beforeEach' || next === 'afterEach' ? next : undefined;
      steps.holdable = next === 'beforeEach' || next === 'body';
    };
    let timedOut = false;
    // The polls the fixtures, the beforeEach hooks, and the body start.
    const bodyPolls = new PollScope('the test body');
    // Captured the moment the primary failure lands: steps that pass later —
    // afterEach cleanup, teardown — must not confirm traces the failure
    // implicated (a cleanup assertion says nothing about the failed flow).
    let lastVerifiedAtFailure = -1;
    // Whether any failure, primary or later, says something about the app:
    // one where no model answered does not, but an afterEach assertion
    // failing after it still implicates the flows nothing confirmed.
    let implicatesUnconfirmed = false;
    // The first failure is the verdict; whatever lands after it, a teardown
    // that also threw or a rejection surfacing late, is kept beside it.
    const recordFailure = (cause: unknown, atPhase: AttemptPhase): void => {
      const classified = classifyError(cause);
      if (!isModelUnreachable(classified)) implicatesUnconfirmed = true;
      if (failure !== undefined) {
        secondaryErrors.push(
          serializeError(classified, { phase: atPhase, projectRoot: this.config.projectRoot, redact }),
        );
        return;
      }
      lastVerifiedAtFailure = steps.lastVerifiedStepIndex;
      failure = classified;
      failurePhase = atPhase;
    };
    // One more look at the app the moment the failure lands: what the screen
    // held then is the evidence the message lacks. Taken before teardown, so
    // an `afterEach` that navigates away or resets state cannot replace it.
    // Once per attempt: a screen that yielded nothing within the budget is
    // not asked again, so a hung app costs the budget once.
    let evidenceTried = false;
    const captureEvidence = async (): Promise<void> => {
      if (failure === undefined || evidenceTried || openSession === null || this.interruptSignal.aborted) return;
      evidenceTried = true;
      const evidence = await captureFailureEvidence({
        session: openSession,
        error: failure,
        ledger: sessionLedger(openSession, this.config.allSecrets),
        config: this.config,
        appOrigin: this.target.app.base?.origin,
        artifacts: artifacts.sink,
        operation: (signal, timeoutMs) => this.op(attemptId, timeoutMs, signal),
        interrupt: this.interruptSignal,
      }).catch(() => undefined);
      if (evidence !== undefined) record.failure = evidence;
    };
    const inMemory = this.options.inMemory?.file === pair.test.file ? this.options.inMemory : undefined;
    const cache =
      inMemory === undefined
        ? createAgentCacheContext({
            cache: this.config.cache,
            projectRoot: this.config.projectRoot,
            projectId: this.config.projectId,
            testId: pair.test.id,
            target: this.sessionIdentity,
            attemptIndex,
            recordings: this.storedRecordings,
          })
        : undefined;

    // A rejection nobody caught, handed in by the process while this attempt
    // is in flight. Set while the body's race is pending, so the rejection
    // ends the body like a timeout; at any other point it is recorded against
    // the phase it landed in, beside a failure already there.
    let cutBody: ((cause: unknown) => void) | undefined;
    this.strayFailure = (cause) => {
      if (cutBody !== undefined) {
        attemptAbort.abort();
        cutBody(cause);
        return;
      }
      recordFailure(cause, phase);
    };

    try {
      const session =
        shared?.session ??
        (await this.launchSession({ session: pair.options.session, recordings }, attemptId, artifacts.dir, attemptAbort.signal));
      openSession = session;
      // A serial group's session serves one member at a time; what the app
      // logs from here is this attempt's.
      session.appLog.route((event, at) => steps.recordAppEvent(event, at));
      session.screens.route((observation) =>
        steps.recordScreen(() =>
          traceScreen(observation, {
            ledger: sessionLedger(session, this.config.allSecrets),
            maxBytes: this.config.limits.maxObservationBytes,
            appOrigin: this.target.app.base?.origin,
          }),
        ),
      );

      const testDeadline = new Deadline(pair.options.timeout);
      this.options.events?.onAttemptDeadline?.(pair, { index: attemptIndex, id: attemptId, startedAt });
      const budget = new AttemptBudget(attemptAbort.signal, testDeadline);
      if (holdStep !== undefined) {
        const title = pair.test.titlePath.join(' › ');
        holds = new AttemptHolds({
          budget,
          signal: attemptAbort.signal,
          ask: (step, signal) =>
            holdStep(
              { target: this.target.name, testId: pair.test.id, agent: pair.agent, repeat: pair.repeat, title, api: step.api, label: step.label, ...(step.source === undefined ? {} : { source: step.source }) },
              signal,
            ),
          // The runner's watchdog keeps the test deadline too; it gets what is left.
          onResume: (remainingMs) =>
            this.options.events?.onAttemptDeadline?.(pair, { index: attemptIndex, id: attemptId, startedAt, remainingMs }),
        });
      }
      const saveSession =
        context.kind !== 'setup'
          ? undefined
          : async (name: string): Promise<void> => {
              if (session.captureState === undefined) {
                throw new ConfigurationError(
                  'UNSUPPORTED_CAPABILITY',
                  `target "${this.target.name}" has no engine state capability for session.save()`,
                );
              }
              const state = await session.captureState(
                this.op(attemptId, this.config.actionTimeout, attemptAbort.signal),
              );
              context.staging.stage(
                name,
                state,
                carriedSecrets(sessionLedger(session, this.config.allSecrets), this.config.allSecrets),
              );
            };
      const { fixtures } = createFixtures({
        config: inMemory?.agents === undefined ? this.config : { ...this.config, agents: inMemory.agents },
        target: this.target,
        session,
        steps,
        budget,
        runId: this.options.runId,
        attemptId,
        attempt,
        artifacts: artifacts.sink,
        priorSteps,
        agentContext: pair.options.agentContext,
        agent: pair.agent,
        saveSession,
        ...(cache === undefined ? {} : { cache }),
        debug: this.debug,
        models: this.models,
        test: { file: pair.test.file, titlePath: pair.test.titlePath, writtenScreenshots: this.writtenScreenshots },
      });
      // `expect.poll` and `expect.soft` take no fixture, so the attempt they
      // run on is published here and cleared when `attemptEnd` fires in `finally`.
      const soft = new SoftFailures();
      publishAttempt(
        {
          attemptId,
          owner: 'suite',
          testKind: pair.test.kind,
          assertionTimeout: this.config.assertionTimeout,
          budget,
          soft,
          ...(context.kind === 'ordinary'
            ? {
                expectFailure: (reason: string) => {
                  if (phase === 'afterEach') throw lateExpectedFailureError();
                  expectedFailure ??= reason;
                },
              }
            : {}),
        },
        attemptEnd.signal,
      );

      const beforeEachHooks = this.realms.hooksFor(realm, registered, 'beforeEach');
      const afterEachHooks = this.realms.hooksFor(realm, registered, 'afterEach');
      // The test's own chain decides the fixture set; hooks get the same
      // object, whichever `test` they were registered through.
      const extended = createExtendedFixtures(
        registered.fixtures,
        fixtures,
        this.target.engine?.name ?? 'none',
        attemptAbort.signal,
      );

      /**
       * Steps and polls the body left running when it settled were not
       * awaited. A step is recorded as failed at its call, cancelled through
       * the attempt signal the way a timeout cancels the body, and waited for
       * within one cleanup budget, so teardown starts on a quiet session.
       * Left alone, such a step would fail once the session closed with
       * nobody to catch it and take the worker down. A poll is cancelled
       * alone; left alone, its timeout would fail whatever ran then.
       * Returns their errors, steps first.
       */
      const abandonNotAwaited = async (): Promise<TestError[]> => {
        if (attemptEnd.signal.aborted) return [];
        const pollsNotAwaited = bodyPolls.close();
        const stepsNotAwaited = steps.abandonRunning();
        if (stepsNotAwaited !== undefined) {
          attemptAbort.abort();
          await withTimeout(
            steps.settleAbandoned(),
            this.config.cleanupTimeout,
            () => new Error('abandoned steps did not settle'),
          ).catch(() => undefined);
        }
        return [stepsNotAwaited, pollsNotAwaited].filter((error) => error !== undefined);
      };
      const mainWork = async (): Promise<void> => {
        try {
          enter('beforeEach');
          await extended.setUp();
          attemptAbort.signal.throwIfAborted();
          for (const hook of beforeEachHooks) {
            await hook.fn(fixtures);
            attemptAbort.signal.throwIfAborted();
          }
          enter('body');
          await (registered.fn as SetupFn)(fixtures);
        } catch (cause) {
          // The body's own failure stays the verdict; the step it abandoned
          // and the soft failures it kept are noted beside it. A skip leaves
          // its soft failures to be settled after the race, and a step or
          // poll it left running is not one.
          const notAwaited = await abandonNotAwaited();
          if (isRuntimeSkip(cause)) throw cause;
          for (const secondary of [...notAwaited, soft.close()]) {
            if (secondary !== undefined) {
              secondaryErrors.push(serializeError(secondary, { phase: 'body', projectRoot: this.config.projectRoot, redact }));
            }
          }
          throw cause;
        }
        const [notAwaited, ...moreNotAwaited] = await abandonNotAwaited();
        for (const secondary of moreNotAwaited) {
          secondaryErrors.push(serializeError(secondary, { phase: 'body', projectRoot: this.config.projectRoot, redact }));
        }
        if (notAwaited !== undefined) throw notAwaited;
        // Soft failures fail the attempt once the body has settled, before
        // `afterEach`; a soft matcher in a hook finds collection closed and throws.
        const softFailure = soft.close();
        if (softFailure !== undefined) throw softFailure;
      };

      // The interrupt is raced here, not only threaded through the fixtures:
      // a body that is not touching the harness at that moment (a plain
      // sleep, a third-party call) would otherwise hold the attempt until its
      // own timeout — minutes, on a device target. The abandoned body goes
      // down with the worker process; the attempt records the interrupt and
      // moves to cleanup.
      const work = this.options.isolated
        ? withAbort(
            runInPollScope(bodyPolls, mainWork),
            this.interruptSignal,
            () => new E2EError('interrupted', 'INTERRUPTED', interruptedInPhase(this.interruptSignal, phase)),
          )
        : runInPollScope(bodyPolls, mainWork);
      const body = Promise.race([
        work,
        new Promise<never>((_, reject) => {
          cutBody = reject;
        }),
      ]);
      try {
        const onTimeout = (): Error => {
          timedOut = true;
          attemptAbort.abort();
          return new TestTimeoutError(`test timed out after ${pair.options.timeout} ms in phase ${phase}`);
        };
        await this.debug.time('test.body', () =>
          holds === undefined ? withTimeout(body, Math.max(1, testDeadline.remaining()), onTimeout) : holds.race(body, onTimeout),
        );
      } catch (cause) {
        // The race has settled: a rejection surfacing while the evidence is
        // captured is recorded, not aimed at it.
        cutBody = undefined;
        // A body cut short may have been awaiting its polls; they end with it.
        bodyPolls.close();
        // `skipRunningTest` has already refused the cases that may not skip.
        if (isRuntimeSkip(cause)) skipped = cause;
        else {
          recordFailure(cause, phase);
          await captureEvidence();
        }
      }
      cutBody = undefined;
      // A promise the body rejected and never awaited reaches the process
      // once the microtasks drain, which is after the body settled but before
      // the next turn of the event loop; waiting that turn out lands it on
      // this attempt instead of between two.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // A body that skipped itself, timed out, or was interrupted never
      // closed its soft failures; they are settled here so teardown starts
      // with the collection closed either way, and a soft matcher in a hook
      // throws. A soft failure is sticky: it fails an attempt that then
      // skipped, and sits beside a timeout or interrupt that came first.
      const lateSoft = soft.close();
      if (lateSoft !== undefined) {
        recordFailure(lateSoft, 'body');
        await captureEvidence();
      }
      // A callback the surface ran for the body (a request interceptor, a
      // dialog handler) fails on a path no step awaits; one that failed after
      // the last step is collected here, so it is the verdict instead of the
      // next attempt's surprise. Evidence is taken now, before a teardown
      // navigates away from the page the callback saw.
      try {
        await this.settleAttempt(session, attemptId);
      } catch (cause) {
        recordFailure(cause, 'body');
        await captureEvidence();
      }

      enter('afterEach');
      // Each teardown gets its own cleanup budget: a body that timed out or
      // was cancelled must not leave the hook with dead fixtures, and a hook
      // that overruns has its own operations cancelled, not the next hook's.
      // Only a run interrupt still cuts cleanup short. Fixture teardowns
      // follow the hooks, last set up first, and fail the attempt like them.
      const teardowns = [
        ...afterEachHooks.map((hook) => ({ label: `${hook.kind} hook`, run: () => hook.fn(fixtures) })),
        ...extended.teardowns().map((teardown) => ({
          label: `fixture "${teardown.name}" teardown`,
          run: teardown.run,
        })),
      ];
      for (const teardown of teardowns) {
        const hookAbort = budget.enter(this.interruptSignal, this.config.cleanupTimeout);
        try {
          await runHook(teardown.label, teardown.run, this.config.cleanupTimeout, () =>
            hookAbort.abort(),
          );
        } catch (cause) {
          recordFailure(cause, 'afterEach');
        }
      }
      await this.settleAttempt(session, attemptId).catch((cause: unknown) => recordFailure(cause, 'afterEach'));
    } catch (cause) {
      recordFailure(cause, phase);
    } finally {
      bodyPolls.close();
      this.strayFailure = undefined;
      this.lastAttemptTestId = pair.test.id;
      attemptEnd.abort();
      this.interruptSignal.removeEventListener('abort', onInterrupt);
      // The verdict is reached before the session closes: nothing after this
      // point changes it, and the close reads it to decide what the attempt's
      // recording is worth.
      if (failure === undefined && skipped !== undefined) {
        record.status = 'skipped';
        record.skip = { cause: 'explicit', reason: truncateUtf8(sanitizeText(redact(skipped.reason)), 8192) };
      } else if (failure === undefined) {
        record.status = 'passed';
      } else {
        record.status = classifyAttemptStatus(failure, timedOut, this.interruptSignal.aborted);
        record.error = serializeError(failure, { phase: failurePhase ?? phase, projectRoot: this.config.projectRoot, redact });
        // A failure outranks the skip; the reason stays beside it.
        if (skipped !== undefined) record.skip = { cause: 'explicit', reason: truncateUtf8(sanitizeText(redact(skipped.reason)), 8192) };
        // A failure that first landed in teardown has had no look yet.
        await captureEvidence();
      }
      // The cache below still settles on what the attempt did, read off `failure`.
      settleExpectedFailure(record, expectedFailure, {
        serialize: (error) => serializeError(error, { phase: 'body', projectRoot: this.config.projectRoot, redact }),
        redact,
      });
      // A serial member's recording ends with the member, not the group.
      if (openSession !== null && shared !== undefined) {
        await this.stopRunningRecording(openSession, attemptId, record, artifacts.sink, secondaryErrors);
      }
      if (openSession !== null && shared === undefined) {
        await this.closeSession(openSession, { attemptId, video }, record, artifacts.sink, secondaryErrors);
      }
      if (openSession !== null) {
        const environment = openSession.environment.read(redact);
        if (environment !== undefined) record.environment = environment;
      }
      // What a shared session's app logs from here waits for the next member.
      openSession?.appLog.route(undefined);
      openSession?.screens.route(undefined);
    }

    // Size and digest land asynchronously; the record is read right after.
    await artifacts.settle();
    record.durationMs = Date.now() - startedMs;
    record.steps = [...steps.all()];
    const appLog = steps.appLog();
    if (appLog.length > 0) record.appLog = [...appLog];

    // Settled only after the status is classified. An interrupted attempt
    // implicates nothing: it writes nothing and evicts nothing, so Ctrl-C can
    // never evict a good entry. On a failure, confirmation stops at what had
    // been verified when the failure landed; later teardown steps prove
    // nothing about the flow. An attempt whose every failure is that no model
    // answered implicates nothing unconfirmed, so a provider outage evicts no
    // entry.
    if (cache !== undefined) {
      const writes = await settleStagedTraces(
        cache,
        record.status === 'interrupted'
          ? undefined
          : {
              lastVerifiedStepIndex: failure === undefined ? steps.lastVerifiedStepIndex : lastVerifiedAtFailure,
              implicatesUnconfirmed: failure === undefined || implicatesUnconfirmed,
            },
      );
      for (const step of record.steps) {
        const write = writes.get(step.index);
        if (step.cache !== undefined && write !== undefined) step.cache.write = write;
      }
    }
    return record;
  }
}
