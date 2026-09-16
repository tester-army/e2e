/** Test-target execution engine. */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { TargetSession, OperationContext } from '../engine/surface.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import {
  classifyError,
  ConfigurationError,
  E2EError,
  InfrastructureError,
  serializeError,
  TestTimeoutError,
  translateEngineError,
  type SerializedError,
} from '../internal/errors.ts';
import { isRuntimeSkip, type RuntimeSkip } from '../internal/skip.ts';
import type { ExecutorAttempt } from '../agent/executor.ts';
import { withAiTraceScope } from '../internal/ai-trace.ts';
import { DebugTrace } from '../internal/debug.ts';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import { Deadline, withAbort, withTimeout } from '../internal/time.ts';
import { createAgentCacheContext, flushStagedTraces } from '../cache/context.ts';
import type { CollectedFile } from '../collect/collect.ts';
import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import type { TestTargetPair } from '../collect/select.ts';
import type { ArtifactStore } from '../types.ts';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { ENGINE_SPI_VERSION } from '../engine/contract.ts';
import { createEngineSession } from '../engine/session.ts';
import { createExtendedFixtures } from './extended-fixtures.ts';
import { captureFailureEvidence } from './failure-evidence.ts';
import { createFixtures, type ArtifactSink } from './fixtures.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { findRegistered, RealmManager, runHook, type Realm } from './realm.ts';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  RunError,
  SerialGroupRecord,
} from './records.ts';
import { isFailedStatus } from './records.ts';
import { runWithRetries } from './retry.ts';
import { runSerialUnit, type SerialHost, type SharedSerialSession } from './serial.ts';
import { INTERRUPTED_BEFORE_START, pairKey, pairResult, unstartedResult } from './units.ts';
import { sessionSecrecy } from './secrecy.ts';
import { SessionStaging, SessionStore, type SessionIdentity } from './sessions.ts';
import { redactTraceArchives } from './trace-redaction.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import { WorkerModels } from './worker-models.ts';
import type { SetupFn } from '../types.ts';

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
  onSerialGroup?(group: SerialGroupRecord): void;
  /** Fires before a runnable pair starts; a serial unit announces each member as it begins. */
  onPairStart?(pair: TestTargetPair): void;
  /** Live step progress of one running attempt, for reporters. */
  onProgress?(pair: TestTargetPair, progress: StepProgress): void;
  /**
   * A run-level configuration failure met mid-run, such as an unusable model
   * on the first `agent` acquisition. The run should stop; the error is
   * recorded once for the run, not against the test that met it.
   */
  onRunAbort?(error: RunError): void;
}

export interface TargetExecutorOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly sessionStore: SessionStore;
  readonly headed: boolean;
  /** This worker's slot among the target's workers; see `EngineInitInfo.workerSlot`. */
  readonly workerSlot: number;
  /** This worker's environment; see `EngineInitInfo.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Whether this executor runs in a process of its own that ends with its
   * work. Only then can an interrupted test body be abandoned mid-flight:
   * the process takes it down. In the runner's own process (a `rawConfig`
   * run) the body would keep executing after the run resolved, so there the
   * interrupt waits for it to reach a harness call or its timeout.
   */
  readonly isolated: boolean;
  readonly interruptSignal: AbortSignal;
  readonly debug?: DebugTrace;
  readonly events?: ExecutionEvents;
}

type AttemptPhase = 'launch' | 'beforeEach' | 'body' | 'afterEach';

/**
 * The slice of an attempt record a session close reads and writes: the
 * verdict the caller has already reached, and the cleanup outcome the close
 * reports.
 */
export interface ClosingRecord {
  readonly status: AttemptRecord['status'];
  cleanup: AttemptRecord['cleanup'];
}

/** Signal for operations that only end when they finish, such as cleanup. */
const NEVER_ABORTS = new AbortController().signal;

/** The file-path slice of a collected file that unit execution needs. */
export type FileRef = Pick<CollectedFile, 'file' | 'absolutePath'>;

/** How one attempt acquires its session and session-staging hooks. */
export type AttemptContext =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'setup'; readonly staging: SessionStaging }
  | { readonly kind: 'serial'; readonly shared: SharedSerialSession };

/** Executes every selected pair for one target sequentially. */
export class TargetExecutor implements SerialHost {
  readonly target: ResolvedTarget;
  get runId(): string {
    return this.options.runId;
  }
  get artifactStore(): ArtifactStore | undefined {
    return this.config.artifactStore;
  }
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
  readonly debug: DebugTrace;

  private readonly runErrors: RunError[] = [];
  private readonly models: WorkerModels;
  private readonly sessionIdentity: SessionIdentity;
  /** Resolves once the engine's init hook completed for this worker. */
  private engineReady: Promise<void> | undefined;

  constructor(private readonly options: TargetExecutorOptions) {
    this.target = options.target;
    this.artifactsRoot = options.artifactsRoot;
    this.interruptSignal = options.interruptSignal;
    this.debug = options.debug ?? new DebugTrace(false);
    this.models = new WorkerModels((error) => {
      options.events?.onRunAbort?.({ error: serializeError(error) });
    });
    this.realms = new RealmManager({
      targetName: options.target.name,
      platform: options.target.platform,
      timeout: options.config.timeout,
      cleanupTimeout: options.config.cleanupTimeout,
      runErrors: this.runErrors,
      debug: this.debug,
    });
    this.sessionIdentity = {
      targetId: options.target.name,
      // Session and cache identity comes from the engine declaration, so a
      // engine swap never restores another engine's state.
      engineName: options.target.engine?.name ?? 'none',
      engineVersion: options.target.engine?.version ?? 'unversioned',
      spiVersion: options.target.engine?.spiVersion ?? ENGINE_SPI_VERSION,
      platform: options.target.platform,
      // The engine's declared identity (else the URL it declared) keys cache
      // and session entries, so an ephemeral per-deploy origin (a PR preview)
      // can share them with the app it is a deployment of. The environment
      // always joins the digest: an identity must never bleed entries across
      // environments.
      appIdentity: canonicalDigest(
        obj({ identity: options.target.app.identity, environment: options.target.app.environment }),
      ),
    };
  }

  private get config(): ResolvedConfig {
    return this.options.config;
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

  /** Builds one engine operation context. */
  private op(attemptId: string, timeoutMs: number, signal: AbortSignal): OperationContext {
    return { signal, timeoutMs, runId: this.options.runId, attemptId, origin: 'test' };
  }

  /** Run-level errors recorded so far, in order. */
  collectedRunErrors(): readonly RunError[] {
    return this.runErrors;
  }

  /**
   * Runs the engine's init hook once per worker, before the first session.
   * Boot work (simulators, device leases) is bounded by the launch timeout
   * but never charged against a step budget.
   */
  private initEngineOnce(): Promise<void> {
    const engine = this.target.engine;
    const init = engine?.init?.bind(engine);
    if (init === undefined) return Promise.resolve();
    // Memoized for the worker's lifetime, failure included: an engine that
    // could not boot fails every attempt on this worker with the same cause
    // instead of re-running a broken boot per test. Init outlives any single
    // attempt, so it aborts on worker interrupt, not on one test's deadline.
    this.engineReady ??= this.debug.time('engine.init', () =>
      this.lifecycle(
        `initializing engine ${engine?.name ?? 'none'}`,
        this.config.launchTimeout,
        'LAUNCH_TIMEOUT',
        this.interruptSignal,
        (signal) =>
          init({
            runId: this.options.runId,
            targetName: this.target.name,
            projectRoot: this.config.projectRoot,
            app: obj({ site: this.target.app.site }),
            env: this.options.env,
            headed: this.options.headed,
            workerSlot: this.options.workerSlot,
            signal,
          }),
      ),
    );
    return this.engineReady;
  }

  /**
   * Runs one lifecycle call on the engine seam within the given budget. The
   * signal handed to `run` follows `parent` and is aborted the moment the call
   * fails, timeout included, so a hook that outlived its budget is told to
   * stop instead of running on into the retry. Synchronous throws are caught,
   * and every failure is translated onto the runner taxonomy: an engine
   * failing outside its contract is infrastructure, never a test error.
   */
  private async lifecycle<T>(
    label: string,
    timeoutMs: number,
    code: 'LAUNCH_TIMEOUT' | 'CLEANUP_TIMEOUT',
    parent: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const scope = new AbortController();
    try {
      return await withTimeout(
        Promise.resolve().then(() => run(AbortSignal.any([parent, scope.signal]))),
        timeoutMs,
        () => new InfrastructureError(code, `${label} timed out`),
      );
    } catch (cause) {
      scope.abort();
      throw translateEngineError(cause, ` while ${label}`);
    }
  }

  /**
   * Disposes the engine at worker end of life, bounded by the cleanup budget.
   * Runs whether or not `init` did: an engine may hold resources it acquired
   * lazily, and the contract makes `dispose` safe to call on a cold engine.
   */
  async dispose(): Promise<void> {
    const disposeEngine = this.target.engine?.dispose?.bind(this.target.engine);
    if (disposeEngine === undefined) return;
    try {
      await this.lifecycle(
        'disposing the engine',
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => disposeEngine({ signal, timeoutMs: this.config.cleanupTimeout }),
      );
    } catch (cause) {
      this.runErrors.push({ error: serializeError(classifyError(cause), { phase: 'cleanup' }) });
    }
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
      freshRegistration === undefined ? null : this.realms.adopt(freshRegistration);
    for (const [index, pair] of ordered.entries()) {
      if (this.interruptSignal.aborted) {
        this.emit(unstartedResult(pair, INTERRUPTED_BEFORE_START));
        continue;
      }
      if (pair.test.serialId !== undefined) {
        // One serial unit per agent the group runs as: its members are the
        // group's pairs under that agent, in declaration order.
        const unitKey = pairKey(pair.test.serialId, pair.agent);
        if (!executedSerialUnits.has(unitKey)) {
          executedSerialUnits.add(unitKey);
          const members = ordered.filter(
            (member) => member.test.serialId === pair.test.serialId && member.agent === pair.agent,
          );
          // A serial group owns its realm; whatever realm ordinary tests were
          // sharing ends here, afterAll included.
          if (realm !== null) await this.realms.leave(realm);
          realm = null;
          await runSerialUnit(this, members, file.absolutePath);
        }
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
        if (realm === null) realm = await this.realms.create(file.absolutePath);
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
        if (isFailedStatus(attempt.status)) {
          // A failed realm is never reused, but afterAll still runs for every
          // scope whose beforeAll started in it. A body that skipped itself
          // left the suite instance as it found it, so the next test keeps it.
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
    const absolutePath = path.resolve(this.config.projectRoot, pair.test.file);
    const attempts: AttemptRecord[] = [];
    let hookFailure: SerializedError | undefined;

    const finalStatus = await runWithRetries(
      pair.options.retries + 1,
      this.interruptSignal,
      async (attemptIndex) => {
        const realm =
          attemptIndex === 0 && freshRegistration !== undefined
            ? this.realms.adopt(freshRegistration)
            : await this.realms.create(absolutePath);
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
        attempts.push(attempt);
        await this.realms.leave(realm);

        if (attempt.status === 'passed') {
          const missing = staging.missing();
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
            return attempt;
          }
          for (const [name, state] of staging.entries()) {
            await this.options.sessionStore.save(name, this.sessionIdentity, state);
          }
        }
        return attempt;
      },
    );

    this.emitUnitResult(pair, finalStatus, attempts, hookFailure);
  }

  // --- attempt core ---

  /** Starts one attempt on the engine, restores a configured session, and starts tracing. */
  async launchSession(
    sessionName: string | undefined,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<TargetSession> {
    // The engine booted in init() once per worker; the adapter is per-attempt
    // so refs never cross attempts.
    await this.initEngineOnce();
    const engine = this.target.engine;
    // Session restore rides the engine's neutral state capability. Checked
    // before any per-attempt isolation opens, so a misconfigured session never
    // orphans a started attempt.
    if (sessionName !== undefined && engine?.state === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${this.target.name}" has no engine state capability for session restore`,
      );
    }
    const session = createEngineSession({ engine, targetName: this.target.name });
    const launch = <T>(label: string, run: (launchSignal: AbortSignal) => Promise<T>) =>
      this.lifecycle(label, this.config.launchTimeout, 'LAUNCH_TIMEOUT', signal, run);
    const launchOp = (launchSignal: AbortSignal) =>
      this.op(attemptId, this.config.launchTimeout, launchSignal);
    try {
      const startAttempt = engine?.startAttempt?.bind(engine);
      if (startAttempt !== undefined) {
        await this.debug.time('session.launch', () =>
          launch(`starting an attempt on engine ${engine?.name ?? 'none'}`, (launchSignal) =>
            startAttempt({ attemptId, artifactsDir, signal: launchSignal }),
          ),
        );
      }
      if (sessionName !== undefined) {
        const state = await this.options.sessionStore.load(sessionName, this.sessionIdentity);
        await launch('restoring the session', (launchSignal) =>
          session.restoreState!(state, launchOp(launchSignal)),
        );
      }
      // A recording the run asked for starts here, when the engine has it. A
      // required kind's failure fails the launch; a best-effort kind's is
      // swallowed. Video before trace: a surface that records both through
      // one screencast sizes it for whichever came first, and the recording
      // is the one a person watches.
      const startRecording = async (
        kind: 'trace' | 'video',
        start: ((operation: OperationContext) => Promise<void>) | undefined,
      ): Promise<void> => {
        const policy = this.config.artifacts.get(kind);
        if (policy === undefined || start === undefined) return;
        const starting = launch(`starting the ${kind}`, (launchSignal) => start(launchOp(launchSignal)));
        if (policy === 'required') await starting;
        else await starting.catch(() => undefined);
      };
      await startRecording('video', session.artifacts.startVideo);
      await startRecording('trace', session.artifacts.startTrace);
    } catch (cause) {
      // The attempt's isolation is open, or a timed-out startAttempt may still
      // open it: end it within the cleanup budget, or the retry opens a second
      // one. An engine without startAttempt makes this a no-op.
      await this.endAttempt(session, attemptId).catch(() => undefined);
      throw cause;
    }
    return session;
  }

  /** Ends one attempt's isolation within the cleanup budget. */
  private endAttempt(session: TargetSession, attemptId: string): Promise<void> {
    return this.lifecycle(
      'ending the attempt',
      this.config.cleanupTimeout,
      'CLEANUP_TIMEOUT',
      NEVER_ABORTS,
      (signal) => session.close(this.op(attemptId, this.config.cleanupTimeout, signal)),
    );
  }

  /**
   * Finalizes the recordings, then ends the attempt with a fresh cleanup
   * budget. The caller has classified the attempt by now: `record.status`
   * decides whether a `retain: 'on-failure'` video is kept.
   */
  async closeSession(
    session: TargetSession,
    attemptId: string,
    record: ClosingRecord,
    artifactSink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void> {
    const { stopVideo, stopTrace } = session.artifacts;
    if (stopVideo !== undefined) {
      await this.stopRecording('video', attemptId, record, secondaryErrors, async (operation) => {
        const segments = await stopVideo(operation);
        if (this.config.videoRetain === 'on-failure' && !isFailedStatus(record.status)) {
          // Recorded so a failure could be watched; a pass has nothing to show.
          await Promise.all(
            segments.map((segment) => rm(path.join(artifactSink.dir, segment.path), { force: true })),
          );
          return;
        }
        for (const segment of segments) {
          artifactSink.register('video', segment.path, { startedAt: segment.startedAt });
        }
      });
    }
    if (stopTrace !== undefined) {
      await this.stopRecording('trace', attemptId, record, secondaryErrors, async (operation) => {
        const stopped = await stopTrace(operation);
        const archives = typeof stopped === 'string' ? [stopped] : stopped;
        // An engine records what happened, filled secrets included, so the
        // trace is the runner's to redact before anything hashes or stores
        // it. Only a session a secret was filled on can have recorded one:
        // the taint is the fill's own mark, so an untainted trace needs no
        // rewriting, and a tainted one is kept only once rewritten.
        const secrecy = sessionSecrecy(session, this.config.secrets);
        let redaction: 'complete' | 'not-required' = 'not-required';
        if (secrecy.taint.value) {
          try {
            await redactTraceArchives(artifactSink.dir, archives, secrecy.ledger);
          } catch (cause) {
            // The trace is gone. The report says why whatever the policy, and
            // a required trace that is missing is a cleanup failure.
            secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
            if (this.config.artifacts.get('trace') === 'required') record.cleanup = 'failed';
            return;
          }
          redaction = 'complete';
        }
        for (const relative of archives) artifactSink.register('trace', relative, { redaction });
      });
    }
    try {
      await this.debug.time('session.close', () => this.endAttempt(session, attemptId));
    } catch (cause) {
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

  /**
   * Stops one recording the run asked for, within the cleanup budget. A
   * required kind that cannot be finalized is a cleanup failure the report
   * must show; a best-effort kind fails quietly.
   */
  private async stopRecording(
    kind: 'trace' | 'video',
    attemptId: string,
    record: ClosingRecord,
    secondaryErrors: SerializedError[],
    stop: (operation: OperationContext) => Promise<void>,
  ): Promise<void> {
    const policy = this.config.artifacts.get(kind);
    if (policy === undefined) return;
    try {
      await this.lifecycle(
        `stopping the ${kind}`,
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => stop(this.op(attemptId, this.config.cleanupTimeout, signal)),
      );
    } catch (cause) {
      if (policy !== 'required') return;
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
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
      () => this.executeAttempt(pair, registered, realm, attemptIndex, context),
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
    const startedAt = timestamp();
    const startedMs = Date.now();
    // Serial members borrow the group's shared session, open state, artifact
    // directory, and prior-step context; every other attempt owns its own.
    const shared = context.kind === 'serial' ? context.shared : undefined;
    const onProgress = this.options.events?.onProgress;
    let openSession: TargetSession | null = null;
    // Secret values the session has seen never enter an error record; the
    // ledger is live, so a value resolved mid-attempt is covered too.
    const redact = (text: string): string =>
      openSession === null ? text : sessionSecrecy(openSession, this.config.secrets).ledger.redact(text);
    const steps = new StepRecorder(attemptId, {
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
      index: attemptIndex,
      signal: attemptEnd.signal,
      memory: shared?.memory ?? new Map<string, unknown>(),
    };

    const artifacts = createAttemptArtifacts({
      artifactsRoot: this.artifactsRoot,
      // Serial members share the group's session, and therefore its artifact
      // directory; registering under their own would not resolve on disk. The
      // agent segment keeps a test run as several agents from overwriting itself.
      segments:
        shared?.artifactSegments ??
        [this.target.name, sanitizePathSegment(pair.test.id), pair.agent, `attempt-${attemptIndex}`],
      attemptId,
      currentStepId: () => steps.currentStepId,
      ...(this.config.artifactStore === undefined ? {} : { store: this.config.artifactStore }),
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
      cleanup: 'complete',
    };

    let failure: E2EError | undefined;
    let failurePhase: AttemptPhase | undefined;
    /** Set when the body (or a beforeEach) skipped the test with `test.skip(...)`. */
    let skipped: RuntimeSkip | undefined;
    let phase: AttemptPhase = 'launch';
    let timedOut = false;
    // Captured the moment the primary failure lands: steps that pass later —
    // afterEach cleanup, teardown — must not confirm traces the failure
    // implicated (a cleanup assertion says nothing about the failed flow).
    let lastVerifiedAtFailure = -1;
    const recordFailure = (cause: unknown, atPhase: AttemptPhase): void => {
      if (failure === undefined) lastVerifiedAtFailure = steps.lastVerifiedStepIndex;
      failure = classifyError(cause);
      failurePhase = atPhase;
    };
    // One more look at the app the moment the failure lands: what the screen
    // held then is the evidence the message lacks. Taken before teardown, so
    // an `afterEach` that navigates away or resets state cannot replace it.
    const captureEvidence = async (): Promise<void> => {
      if (failure === undefined || record.failure !== undefined || openSession === null || this.interruptSignal.aborted) return;
      const evidence = await captureFailureEvidence({
        session: openSession,
        error: failure,
        secrecy: sessionSecrecy(openSession, this.config.secrets),
        config: this.config,
        artifacts: artifacts.sink,
        operation: (signal, timeoutMs) => this.op(attemptId, timeoutMs, signal),
        interrupt: this.interruptSignal,
      }).catch(() => undefined);
      if (evidence !== undefined) record.failure = evidence;
    };
    const cache = createAgentCacheContext({
      cache: this.config.cache,
      projectId: this.config.projectId,
      testId: pair.test.id,
      target: this.sessionIdentity,
      attemptIndex,
    });

    try {
      const session =
        shared?.session ??
        (await this.launchSession(pair.options.session, attemptId, artifacts.dir, attemptAbort.signal));
      openSession = session;

      const testDeadline = new Deadline(pair.options.timeout);
      const budget = new AttemptBudget(attemptAbort.signal, testDeadline);
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
              context.staging.stage(name, state);
            };
      const { fixtures } = createFixtures({
        config: this.config,
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
      });
      // `expect.poll` takes no fixture, so the attempt it runs on is
      // published here and cleared when `attemptEnd` fires in `finally`.
      publishAttempt(
        { attemptId, testKind: pair.test.kind, assertionTimeout: this.config.assertionTimeout, budget },
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
      );

      const mainWork = async (): Promise<void> => {
        phase = 'beforeEach';
        await extended.setUp();
        for (const hook of beforeEachHooks) {
          await hook.fn(fixtures);
        }
        phase = 'body';
        await (registered.fn as SetupFn)(fixtures);
      };

      // The interrupt is raced here, not only threaded through the fixtures:
      // a body that is not touching the harness at that moment (a plain
      // sleep, a third-party call) would otherwise hold the attempt until its
      // own timeout — minutes, on a device target. The abandoned body goes
      // down with the worker process; the attempt records the interrupt and
      // moves to cleanup.
      const body = this.options.isolated
        ? withAbort(
            mainWork(),
            this.interruptSignal,
            () => new E2EError('interrupted', 'INTERRUPTED', `run interrupted in phase ${phase}`),
          )
        : mainWork();
      try {
        await this.debug.time('test.body', () =>
          withTimeout(
            body,
            Math.max(1, testDeadline.remaining()),
            () => {
              timedOut = true;
              attemptAbort.abort();
              return new TestTimeoutError(
                `test timed out after ${pair.options.timeout} ms in phase ${phase}`,
              );
            },
          ),
        );
      } catch (cause) {
        // `skipRunningTest` has already refused the cases that may not skip.
        if (isRuntimeSkip(cause)) skipped = cause;
        else {
          recordFailure(cause, phase);
          await captureEvidence();
        }
      }

      phase = 'afterEach';
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
          if (failure === undefined) {
            recordFailure(cause, 'afterEach');
          } else {
            secondaryErrors.push(serializeError(classifyError(cause), { phase: 'afterEach' }));
          }
        }
      }
    } catch (cause) {
      recordFailure(cause, phase);
    } finally {
      attemptEnd.abort();
      this.interruptSignal.removeEventListener('abort', onInterrupt);
      // The verdict is reached before the session closes: nothing after this
      // point changes it, and the close reads it to decide what the attempt's
      // recording is worth.
      if (failure === undefined && skipped !== undefined) {
        record.status = 'skipped';
        record.skip = { cause: 'explicit', reason: skipped.reason };
      } else if (failure === undefined) {
        record.status = 'passed';
      } else {
        record.status = classifyAttemptStatus(failure, timedOut, this.interruptSignal.aborted);
        record.error = serializeError(failure, { phase: failurePhase ?? phase, projectRoot: this.config.projectRoot, redact });
        // A failure that first landed in teardown has had no look yet.
        await captureEvidence();
      }
      if (openSession !== null && shared === undefined) {
        await this.closeSession(openSession, attemptId, record, artifacts.sink, secondaryErrors);
      }
    }

    // Size and digest land asynchronously; the record is read right after.
    await artifacts.settle();
    record.durationMs = Date.now() - startedMs;
    record.steps = [...steps.all()];

    if (cache !== undefined && record.status !== 'interrupted') {
      // Settled only after the status is classified: an interrupted attempt
      // implicates nothing — it writes nothing and evicts nothing — so Ctrl-C
      // can never evict a good entry. On a failure, confirmation stops at what
      // had been verified when the failure landed — later teardown steps
      // prove nothing about the flow.
      await flushStagedTraces(
        cache,
        failure === undefined ? steps.lastVerifiedStepIndex : lastVerifiedAtFailure,
      );
    }
    return record;
  }
}

/**
 * The status of a failed attempt. An interrupt outranks everything except a
 * timeout that had already fired: the attempt then timed out, whatever
 * arrived after.
 */
function classifyAttemptStatus(
  failure: E2EError,
  timedOut: boolean,
  interrupted: boolean,
): 'failed' | 'timed-out' | 'interrupted' {
  if (interrupted && !timedOut) return 'interrupted';
  if (timedOut || failure instanceof TestTimeoutError || failure.code === 'TEST_TIMEOUT') {
    return 'timed-out';
  }
  return 'failed';
}
