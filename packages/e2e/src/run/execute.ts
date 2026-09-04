/** Test-target execution engine (spec 11-lifecycle.md). */

import path from 'node:path';
import type { TargetSession, OperationContext } from '../backend/surface.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import {
  classifyError,
  ConfigurationError,
  E2EError,
  InfrastructureError,
  serializeError,
  TestTimeoutError,
  translateBackendError,
  type SerializedError,
} from '../internal/errors.ts';
import { withAiTraceScope } from '../internal/ai-trace.ts';
import { DebugTrace } from '../internal/debug.ts';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, withAbort, withTimeout } from '../internal/time.ts';
import { createAgentCacheContext, flushStagedTraces } from '../cache/context.ts';
import type { CollectedFile } from '../collect/collect.ts';
import type { ModuleRegistration, RegisteredTest } from '../collect/registry.ts';
import type { TestTargetPair } from '../collect/select.ts';
import type { ArtifactStore } from '../types.ts';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.ts';
import { BACKEND_SPI_VERSION } from '../backend/contract.ts';
import { createBackendSession } from '../backend/session.ts';
import { createFixtures, type ArtifactSink } from './fixtures.ts';
import { findRegistered, RealmManager, type Realm } from './realm.ts';
import type {
  AttemptRecord,
  ResultRecord,
  RunError,
  SerialGroupRecord,
} from './records.ts';
import { runWithRetries } from './retry.ts';
import { runSerialUnit, type SerialHost, type SharedSerialSession } from './serial.ts';
import { INTERRUPTED_BEFORE_START, pairResult, unstartedResult } from './units.ts';
import { SessionStaging, SessionStore, type SessionIdentity } from './sessions.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import type { SetupFn, TestFn } from '../types.ts';

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
  onSerialGroup?(group: SerialGroupRecord): void;
  /** Fires before a runnable pair (or serial unit via its first member) starts. */
  onPairStart?(pair: TestTargetPair): void;
  /** Live step progress of one running attempt, for reporters. */
  onProgress?(testId: string, progress: StepProgress): void;
}

export interface TargetExecutorOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly sessionStore: SessionStore;
  readonly headed: boolean;
  /**
   * Whether this executor runs in a process of its own that ends with its
   * work. Only then can an interrupted test body be abandoned mid-flight:
   * the process takes it down. In the host's own process (a `rawConfig`
   * run) the body would keep executing after the run resolved, so there the
   * interrupt waits for it to reach a harness call or its timeout.
   */
  readonly isolated: boolean;
  readonly interruptSignal: AbortSignal;
  readonly debug?: DebugTrace;
  readonly events?: ExecutionEvents;
}

type AttemptPhase = 'launch' | 'beforeEach' | 'body' | 'afterEach';

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
  private readonly sessionIdentity: SessionIdentity;
  /** Resolves once the backend's init hook completed for this worker. */
  private backendReady: Promise<void> | undefined;

  constructor(private readonly options: TargetExecutorOptions) {
    this.target = options.target;
    this.artifactsRoot = options.artifactsRoot;
    this.interruptSignal = options.interruptSignal;
    this.debug = options.debug ?? new DebugTrace(false);
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
      // Session and cache identity comes from the backend declaration, so a
      // backend swap never restores another backend's state.
      backendName: options.target.backend?.name ?? 'none',
      backendVersion: options.target.backend?.version ?? 'unversioned',
      spiVersion: options.target.backend?.spiVersion ?? BACKEND_SPI_VERSION,
      platform: options.target.platform,
      // An explicit `app.identity` replaces the origin, so an ephemeral
      // per-deploy origin (a PR preview) shares cache and session identity
      // with the app it is a deployment of. The environment always joins the
      // digest: an identity must never bleed entries across environments.
      appIdentity: canonicalDigest(
        options.config.app.identity === undefined
          ? {
              origin: options.config.app.base.origin,
              basePath: options.config.app.base.basePath,
              environment: options.config.app.environment,
            }
          : {
              identity: options.config.app.identity,
              environment: options.config.app.environment,
            },
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

  /** Builds one backend operation context. */
  private op(attemptId: string, timeoutMs: number, signal: AbortSignal): OperationContext {
    return { signal, timeoutMs, runId: this.options.runId, attemptId };
  }

  /** Run-level errors recorded so far, in order. */
  collectedRunErrors(): readonly RunError[] {
    return this.runErrors;
  }

  /**
   * Runs the backend's init hook once per worker, before the first session.
   * Boot work (simulators, device leases) is bounded by the launch timeout
   * but never charged against a step budget.
   */
  private initBackendOnce(): Promise<void> {
    const backend = this.target.backend;
    const init = backend?.init?.bind(backend);
    if (init === undefined) return Promise.resolve();
    // Memoized for the worker's lifetime, failure included: a backend that
    // could not boot fails every attempt on this worker with the same cause
    // instead of re-running a broken boot per test. Init outlives any single
    // attempt, so it aborts on worker interrupt, not on one test's deadline.
    this.backendReady ??= this.debug.time('backend.init', () =>
      this.lifecycle(
        `initializing backend ${backend?.name ?? 'none'}`,
        this.config.launchTimeout,
        'LAUNCH_TIMEOUT',
        this.interruptSignal,
        (signal) =>
          init({
            runId: this.options.runId,
            targetName: this.target.name,
            projectRoot: this.config.projectRoot,
            app: {
              ...(this.config.app.configured ? { baseUrl: this.config.app.base.href } : {}),
              allowedOrigins: this.config.app.allowedOrigins,
            },
            testIdAttribute: this.config.testIdAttribute,
            headed: this.options.headed,
            signal,
          }),
      ),
    );
    return this.backendReady;
  }

  /**
   * Runs one lifecycle call on the backend seam within the given budget. The
   * signal handed to `run` follows `parent` and is aborted the moment the call
   * fails, timeout included, so a hook that outlived its budget is told to
   * stop instead of running on into the retry. Synchronous throws are caught,
   * and every failure is translated onto the runner taxonomy: a backend
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
      throw translateBackendError(cause, ` while ${label}`);
    }
  }

  /**
   * Disposes the backend at worker end of life, bounded by the cleanup budget.
   * Runs whether or not `init` did: a backend may hold resources it acquired
   * lazily, and the contract makes `dispose` safe to call on a cold backend.
   */
  async dispose(): Promise<void> {
    const disposeBackend = this.target.backend?.dispose?.bind(this.target.backend);
    if (disposeBackend === undefined) return;
    try {
      await this.lifecycle(
        'disposing the backend',
        this.config.cleanupTimeout,
        'CLEANUP_TIMEOUT',
        NEVER_ABORTS,
        (signal) => disposeBackend({ signal, timeoutMs: this.config.cleanupTimeout }),
      );
    } catch (cause) {
      this.runErrors.push({ error: serializeError(classifyError(cause), { phase: 'cleanup' }) });
    }
  }

  /**
   * Runs one file-target unit: runnable pairs of a single file, in declaration
   * order, sharing a realm between passing non-serial tests (spec
   * 11-lifecycle.md). Dispatch-time gating (selection dispositions and
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
    for (const pair of ordered) {
      if (this.interruptSignal.aborted) {
        this.emit(unstartedResult(pair, INTERRUPTED_BEFORE_START));
        continue;
      }
      if (pair.test.serialId !== undefined) {
        if (!executedSerialUnits.has(pair.test.serialId)) {
          executedSerialUnits.add(pair.test.serialId);
          const members = ordered.filter((member) => member.test.serialId === pair.test.serialId);
          this.options.events?.onPairStart?.(pair);
          // A serial group owns its realm; whatever realm ordinary tests were
          // sharing ends here, afterAll included.
          if (realm !== null) await this.realms.leave(realm);
          realm = null;
          const group = await runSerialUnit(this, members, file.absolutePath);
          this.options.events?.onSerialGroup?.(group);
        }
        continue;
      }
      this.options.events?.onPairStart?.(pair);
      realm = await this.runOrdinaryPair(pair, file, realm);
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
        if (attempt.status !== 'passed') {
          // Spec 11-lifecycle.md: a failed realm is never reused, but afterAll
          // still runs for every scope whose beforeAll started in it.
          await this.realms.leave(realm);
          realm = null;
        }
        return attempt;
      },
    );

    // A beforeAll failure before any attempt ran skips the test. On a retry
    // the recorded attempts stand: the hook failure is already a run error,
    // and a failing test must not be reported as skipped.
    if (hookFailure !== undefined && attempts.length === 0) {
      this.emit(
        pairResult(pair, {
          status: 'skipped',
          selected: true,
          skip: { cause: 'hook-failed', reason: hookFailure.message },
          attempts: [],
        }),
      );
      return realm;
    }
    this.emit(pairResult(pair, { status: finalStatus, selected: true, attempts }));
    return realm;
  }

  // --- setup tests ---

  /** Runs one setup pair to completion, persisting staged sessions on success. */
  async runSetupUnit(pair: TestTargetPair, freshRegistration?: ModuleRegistration): Promise<void> {
    this.options.events?.onPairStart?.(pair);
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
    this.emit(pairResult(pair, { status: finalStatus, selected: true, attempts }));
  }

  // --- attempt core ---

  /** Starts one attempt on the backend, restores a configured session, and starts tracing. */
  async launchSession(
    pair: TestTargetPair,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<TargetSession> {
    // The backend booted in init() once per worker; the adapter is per-attempt
    // so refs never cross attempts.
    await this.initBackendOnce();
    const backend = this.target.backend;
    // Session restore rides the backend's neutral state capability. Checked
    // before any per-attempt isolation opens, so a misconfigured session never
    // orphans a started attempt.
    if (pair.options.session !== undefined && backend?.state === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${this.target.name}" has no backend state capability for session restore`,
      );
    }
    const session = createBackendSession({ backend, targetName: this.target.name });
    const launch = <T>(label: string, run: (launchSignal: AbortSignal) => Promise<T>) =>
      this.lifecycle(label, this.config.launchTimeout, 'LAUNCH_TIMEOUT', signal, run);
    const launchOp = (launchSignal: AbortSignal) =>
      this.op(attemptId, this.config.launchTimeout, launchSignal);
    try {
      const startAttempt = backend?.startAttempt?.bind(backend);
      if (startAttempt !== undefined) {
        await this.debug.time('session.launch', () =>
          launch(`starting an attempt on backend ${backend?.name ?? 'none'}`, (launchSignal) =>
            startAttempt({ attemptId, artifactsDir, signal: launchSignal }),
          ),
        );
      }
      if (pair.options.session !== undefined) {
        const state = await this.options.sessionStore.load(pair.options.session, this.sessionIdentity);
        await launch('restoring the session', (launchSignal) =>
          session.restoreState!(state, launchOp(launchSignal)),
        );
      }
      if (this.config.artifacts.includes('trace') && session.artifacts.startTrace !== undefined) {
        // An explicitly configured trace is a contract; the default set is best-effort.
        const starting = launch('starting the trace', (launchSignal) =>
          session.artifacts.startTrace!(launchOp(launchSignal)),
        );
        if (this.config.artifactsExplicit) await starting;
        else await starting.catch(() => undefined);
      }
    } catch (cause) {
      // The attempt's isolation is open, or a timed-out startAttempt may still
      // open it: end it within the cleanup budget, or the retry opens a second
      // one. A backend without startAttempt makes this a no-op.
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

  /** Finalizes trace and ends the attempt with a fresh cleanup budget. */
  async closeSession(
    session: TargetSession,
    attemptId: string,
    record: { cleanup: 'complete' | 'failed' | 'forced' },
    artifactSink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void> {
    if (this.config.artifacts.includes('trace') && session.artifacts.stopTrace !== undefined) {
      try {
        const tracePath = await this.lifecycle(
          'stopping the trace',
          this.config.cleanupTimeout,
          'CLEANUP_TIMEOUT',
          NEVER_ABORTS,
          (signal) => session.artifacts.stopTrace!(this.op(attemptId, this.config.cleanupTimeout, signal)),
        );
        artifactSink.register('trace', tracePath);
      } catch (cause) {
        // Best-effort for the default artifact set; a configured trace that
        // cannot be finalized is a cleanup failure the report must show.
        if (this.config.artifactsExplicit) {
          record.cleanup = 'failed';
          secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
        }
      }
    }
    try {
      await this.debug.time('session.close', () => this.endAttempt(session, attemptId));
    } catch (cause) {
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
    const steps = new StepRecorder(attemptId, {
      maxEventsPerStep: this.config.limits.maxEventsPerStep,
      ...(onProgress === undefined
        ? {}
        : { onProgress: (progress: StepProgress) => onProgress(pair.test.id, progress) }),
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

    const artifacts = createAttemptArtifacts({
      artifactsRoot: this.artifactsRoot,
      // Serial members share the group's session, and therefore its artifact
      // directory; registering under their own would not resolve on disk.
      segments:
        shared?.artifactSegments ??
        [this.target.name, sanitizePathSegment(pair.test.id), `attempt-${attemptIndex}`],
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

    let openSession: TargetSession | null = null;
    let failure: E2EError | undefined;
    let failurePhase: AttemptPhase | undefined;
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
        (await this.launchSession(pair, attemptId, artifacts.dir, attemptAbort.signal));
      openSession = session;

      const testDeadline = new Deadline(pair.options.timeout);
      const saveSession =
        context.kind !== 'setup'
          ? undefined
          : async (name: string): Promise<void> => {
              if (session.captureState === undefined) {
                throw new ConfigurationError(
                  'UNSUPPORTED_CAPABILITY',
                  `target "${this.target.name}" has no backend state capability for session.save()`,
                );
              }
              const state = await session.captureState(
                this.op(attemptId, this.config.actionTimeout, attemptAbort.signal),
              );
              context.staging.stage(name, state);
            };
      const fixtures = createFixtures({
        config: this.config,
        target: this.target,
        session,
        steps,
        signal: attemptAbort.signal,
        runId: this.options.runId,
        attemptId,
        testDeadline,
        artifacts: artifacts.sink,
        priorSteps,
        agentContext: pair.options.agentContext,
        saveSession,
        ...(cache === undefined ? {} : { cache }),
        debug: this.debug,
      });

      const beforeEachHooks = this.realms.hooksFor(realm, registered, 'beforeEach');
      const afterEachHooks = this.realms.hooksFor(realm, registered, 'afterEach').toReversed();

      const mainWork = async (): Promise<void> => {
        phase = 'beforeEach';
        for (const hook of beforeEachHooks) {
          await (hook.fn as TestFn)(fixtures);
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
        recordFailure(cause, phase);
      }

      phase = 'afterEach';
      for (const hook of afterEachHooks) {
        try {
          await withTimeout(
            Promise.resolve((hook.fn as TestFn)(fixtures)),
            this.config.cleanupTimeout,
            () => new TestTimeoutError('afterEach hook timed out'),
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
      this.interruptSignal.removeEventListener('abort', onInterrupt);
      if (openSession !== null && shared === undefined) {
        await this.closeSession(openSession, attemptId, record, artifacts.sink, secondaryErrors);
      }
    }

    // Size and digest land asynchronously; the record is read right after.
    await artifacts.settle();
    record.durationMs = Date.now() - startedMs;
    record.steps = [...steps.all()];

    if (failure === undefined) {
      record.status = 'passed';
    } else {
      record.status = classifyAttemptStatus(failure, timedOut, this.interruptSignal.aborted);
      record.error = serializeError(failure, { phase: failurePhase ?? phase });
    }

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
