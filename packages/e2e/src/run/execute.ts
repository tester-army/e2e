/** Test-target execution engine (spec 11-lifecycle.md). */

import path from 'node:path';
import type { AgentCacheContext } from '../agent/invocation.ts';
import { POLICY_VERSION } from '../agent/prompts.ts';
import {
  createCacheStore,
  createCallIndexer,
  disabledCacheStore,
  projectIdentity,
  type CacheStore,
  type CacheTargetIdentity,
} from '../cache/index.ts';
import type { Driver, DriverSession, OperationContext } from '../driver/index.ts';
import { isMobileTarget } from '../config/resolve.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import {
  classifyError,
  ConfigurationError,
  E2EError,
  InfrastructureError,
  serializeError,
  TestTimeoutError,
  type SerializedError,
} from '../internal/errors.ts';
import { DebugTrace } from '../internal/debug.ts';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, withTimeout } from '../internal/time.ts';
import type { CollectedFile } from '../collect/collect.ts';
import type { RegisteredTest } from '../collect/registry.ts';
import type { TestTargetPair } from '../collect/select.ts';
import type { TargetRuntimeProvenance } from '../report/build.ts';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.ts';
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
import { StepRecorder } from './steps.ts';
import type { SetupFn, TestFn } from '../types.ts';

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
  onSerialGroup?(group: SerialGroupRecord): void;
  /** Fires before a runnable pair (or serial unit via its first member) starts. */
  onPairStart?(pair: TestTargetPair): void;
  /**
   * Fires once per target, after its first session reports `runtime()`. It
   * carries the resolved backend provenance the report needs and which no
   * manifest can supply.
   */
  onRuntime?(runtime: TargetRuntimeProvenance): void;
}

export interface TargetExecutorOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly driver: Driver;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly sessionStore: SessionStore;
  readonly headed: boolean;
  readonly interruptSignal: AbortSignal;
  readonly debug?: DebugTrace;
  readonly events?: ExecutionEvents;
}

type AttemptPhase = 'launch' | 'beforeEach' | 'body' | 'afterEach';

/** The file-path slice of a collected file that unit execution needs. */
export type FileRef = Pick<CollectedFile, 'file' | 'absolutePath'>;

/** How one attempt acquires its driver session and session-staging hooks. */
export type AttemptContext =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'setup'; readonly staging: SessionStaging }
  | { readonly kind: 'serial'; readonly shared: SharedSerialSession };

/** Executes every selected pair for one target sequentially. */
export class TargetExecutor implements SerialHost {
  readonly target: ResolvedTarget;
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly realms: RealmManager;
  readonly debug: DebugTrace;

  private readonly runErrors: RunError[] = [];
  private readonly sessionIdentity: SessionIdentity;
  /** Session identity with the deployment-independent app identity of the cache. */
  private readonly cacheTarget: CacheTargetIdentity;
  /**
   * One store per target. Entries are content-addressed by key, so concurrent
   * targets and workers write disjoint files and need no coordination beyond
   * the store's own per-key lock.
   */
  private readonly cacheStore: CacheStore;
  private readonly cacheProject: string;
  private runtimeReported = false;

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
      driverId: options.driver.id,
      driverVersion: options.driver.version,
      spiVersion: options.driver.spiVersion,
      platform: options.target.platform,
      appIdentity: canonicalDigest(
        isMobileTarget(options.target)
          ? { app: options.target.app, environment: options.config.app.environment }
          : {
              origin: options.config.app.base?.origin,
              basePath: options.config.app.base?.basePath,
              environment: options.config.app.environment,
            },
      ),
    };
    // The cache is deployment-independent on purpose: a preview URL, a staging
    // host, and localhost on another port serve the same app, and keying on the
    // origin cold-started every entry on every deploy. The declared environment
    // still separates them, because that is a statement about the app, not
    // about where it happens to be running. Session state keeps the strict
    // identity above: cookies from one origin must never be restored onto
    // another.
    this.cacheTarget = {
      ...this.sessionIdentity,
      appIdentity: canonicalDigest({ environment: options.config.app.environment }),
    };
    this.cacheStore = createCacheStore({
      mode: options.config.agent.cache,
      projectRoot: options.config.projectRoot,
      maxBytes: options.config.limits.maxCacheBytes,
    });
    this.cacheProject = projectIdentity(options.config.projectId);
  }

  /**
   * Cache context for one attempt.
   *
   * A retry starts from clean state, so it gets the disabled store: a cached
   * locator can never be blamed for a flake the retry was supposed to clear.
   * That is a true bypass, not a suppressed hit — no key is built and no
   * screen is fingerprinted, so a bypassed cache costs nothing.
   */
  private cacheContext(testId: string, attemptIndex: number): AgentCacheContext {
    return {
      store:
        attemptIndex === 0
          ? this.cacheStore
          : disabledCacheStore('retry attempts never consult the cache'),
      project: this.cacheProject,
      testId,
      target: this.cacheTarget,
      policyVersion: POLICY_VERSION,
      nextCallIndex: createCallIndexer(),
    };
  }

  private get config(): ResolvedConfig {
    return this.options.config;
  }

  /** Emits one final result record (SerialHost). Records are not retained. */
  emit(result: ResultRecord): void {
    this.options.events?.onResult?.(result);
  }

  /** Builds one driver operation context; defaults to a non-aborting signal. */
  private op(
    attemptId: string,
    timeoutMs: number,
    signal: AbortSignal = new AbortController().signal,
  ): OperationContext {
    return { signal, timeoutMs, runId: this.options.runId, attemptId };
  }

  /** Run-level errors recorded so far, in order. */
  collectedRunErrors(): readonly RunError[] {
    return this.runErrors;
  }

  /**
   * Runs one file-target unit: runnable pairs of a single file, in declaration
   * order, sharing a realm between passing non-serial tests (spec
   * 11-lifecycle.md). Dispatch-time gating (selection dispositions and
   * setup-failure dependencies) belongs to the scheduler, so every pair
   * reaching here is runnable.
   */
  async runFileUnit(file: FileRef, filePairs: readonly TestTargetPair[]): Promise<void> {
    const executedSerialUnits = new Set<string>();
    const ordered = filePairs.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
    let realm: Realm | null = null;
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
          const group = await runSerialUnit(this, members, file.absolutePath);
          this.options.events?.onSerialGroup?.(group);
          realm = null;
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
        if (attempt.status !== 'passed') realm = null;
        return attempt;
      },
    );

    if (hookFailure !== undefined) {
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
  async runSetupUnit(pair: TestTargetPair): Promise<void> {
    this.options.events?.onPairStart?.(pair);
    const absolutePath = path.resolve(this.config.projectRoot, pair.test.file);
    const attempts: AttemptRecord[] = [];

    const finalStatus = await runWithRetries(
      pair.options.retries + 1,
      this.interruptSignal,
      async (attemptIndex) => {
        const realm = await this.realms.create(absolutePath);
        const registered = findRegistered(realm, pair.test);
        if (registered === undefined) {
          this.recordDisappeared(`setup ${pair.test.id} disappeared on re-import`);
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

    this.emit(pairResult(pair, { status: finalStatus, selected: true, attempts }));
  }

  // --- attempt core ---

  /** Launches one driver session, restores a configured session, and starts tracing. */
  async launchSession(
    pair: TestTargetPair,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<DriverSession> {
    const driverSession = await this.debug.time('session.launch', () =>
      withTimeout(
        this.options.driver.launch({
          target: this.target.driverTarget,
          targetId: this.target.name,
          app: {
            ...(this.config.app.base !== undefined
              ? { baseUrl: this.config.app.base.href }
              : {}),
            allowedOrigins: this.config.app.allowedOrigins,
            environment: this.config.app.environment,
            allowProduction: this.config.app.allowProduction,
            testIdAttribute: this.config.testIdAttribute,
          },
          artifactsDir,
          runId: this.options.runId,
          attemptId,
          operation: this.op(attemptId, this.config.launchTimeout, signal),
          launchOptions: { headed: this.options.headed },
        }),
        this.config.launchTimeout,
        () => new InfrastructureError('LAUNCH_TIMEOUT', 'driver launch timed out'),
      ),
    );

    await this.reportRuntimeProvenance(driverSession, attemptId, signal);

    if (pair.options.session !== undefined) {
      const state = await this.options.sessionStore.load(pair.options.session, this.sessionIdentity);
      if (driverSession.restoreState === undefined) {
        throw new ConfigurationError('UNSUPPORTED_CAPABILITY', 'driver does not support state restore');
      }
      await driverSession.restoreState(state, this.op(attemptId, this.config.launchTimeout, signal));
    }

    if (this.config.artifacts.includes('trace') && driverSession.artifacts.startTrace !== undefined) {
      await driverSession.artifacts
        .startTrace(this.op(attemptId, this.config.launchTimeout, signal))
        .catch(() => undefined);
    }
    return driverSession;
  }

  /**
   * Reads resolved backend provenance from the first session of this target.
   * It is best-effort: a driver that cannot report runtime state must not fail
   * the attempt over report metadata.
   */
  private async reportRuntimeProvenance(
    driverSession: DriverSession,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.runtimeReported || this.options.events?.onRuntime === undefined) return;
    this.runtimeReported = true;
    try {
      const runtime = await driverSession.runtime(
        this.op(attemptId, this.config.launchTimeout, signal),
      );
      // A non-positive viewport means the backend could not resolve device
      // geometry. It is omitted rather than published as zeros.
      const resolvedViewport = runtime.viewport.width > 0 && runtime.viewport.height > 0;
      this.options.events.onRuntime({
        ...(resolvedViewport ? { viewport: { ...runtime.viewport } } : {}),
        ...(runtime.browser !== undefined ? { browserVersion: runtime.browser.version } : {}),
        ...(runtime.device !== undefined
          ? { device: runtime.device.name, os: runtime.device.os }
          : {}),
      });
    } catch {
      // Provenance is diagnostic; the attempt owns the failure surface.
    }
  }

  /** Finalizes trace and closes the driver session with a fresh cleanup budget. */
  async closeSession(
    driverSession: DriverSession,
    attemptId: string,
    record: { cleanup: 'complete' | 'failed' | 'forced' },
    artifactSink: ArtifactSink,
    secondaryErrors: SerializedError[],
  ): Promise<void> {
    if (this.config.artifacts.includes('trace') && driverSession.artifacts.stopTrace !== undefined) {
      try {
        const tracePath = await driverSession.artifacts.stopTrace(
          this.op(attemptId, this.config.cleanupTimeout),
        );
        artifactSink.register('trace', tracePath);
      } catch {
        // trace finalization is best-effort
      }
    }
    try {
      await this.debug.time('session.close', () =>
        withTimeout(
          driverSession.close(this.op(attemptId, this.config.cleanupTimeout)),
          this.config.cleanupTimeout,
          () => new InfrastructureError('CLEANUP_TIMEOUT', 'driver close timed out'),
        ),
      );
    } catch (cause) {
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

  /** Runs one attempt to completion (SerialHost). */
  async runAttempt(
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
    const steps = new StepRecorder(attemptId, {
      maxEventsPerStep: this.config.limits.maxEventsPerStep,
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

    let driverSession: DriverSession | null = null;
    let failure: E2EError | undefined;
    let failurePhase: AttemptPhase | undefined;
    let phase: AttemptPhase = 'launch';
    let timedOut = false;

    try {
      const session =
        shared?.session ??
        (await this.launchSession(pair, attemptId, artifacts.dir, attemptAbort.signal));
      driverSession = session;

      const testDeadline = new Deadline(pair.options.timeout);
      const saveSession =
        context.kind !== 'setup'
          ? undefined
          : async (name: string): Promise<void> => {
              if (session.captureState === undefined) {
                throw new ConfigurationError(
                  'UNSUPPORTED_CAPABILITY',
                  'driver does not support state capture',
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
        driverSession: session,
        steps,
        signal: attemptAbort.signal,
        runId: this.options.runId,
        attemptId,
        testDeadline,
        artifacts: artifacts.sink,
        priorSteps,
        cache: this.cacheContext(pair.test.id, attemptIndex),
        agentContext: pair.options.agentContext,
        opened: shared?.opened ?? { value: false },
        saveSession,
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

      try {
        await this.debug.time('test.body', () =>
          withTimeout(mainWork(), Math.max(1, testDeadline.remaining()), () => {
            timedOut = true;
            attemptAbort.abort();
            return new TestTimeoutError(
              `test timed out after ${pair.options.timeout} ms in phase ${phase}`,
            );
          }),
        );
      } catch (cause) {
        failure = classifyError(cause);
        failurePhase = phase;
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
          const hookError = classifyError(cause);
          if (failure === undefined) {
            failure = hookError;
            failurePhase = 'afterEach';
          } else {
            secondaryErrors.push(serializeError(hookError, { phase: 'afterEach' }));
          }
        }
      }
    } catch (cause) {
      failure = classifyError(cause);
      failurePhase = phase;
    } finally {
      this.interruptSignal.removeEventListener('abort', onInterrupt);
      if (driverSession !== null && shared === undefined) {
        await this.closeSession(driverSession, attemptId, record, artifacts.sink, secondaryErrors);
      }
    }

    record.durationMs = Date.now() - startedMs;
    record.steps = [...steps.all()];

    if (failure === undefined) {
      record.status = 'passed';
    } else {
      const reportPhase = failurePhase ?? phase;
      if (this.interruptSignal.aborted && !timedOut) {
        record.status = 'interrupted';
      } else if (timedOut || failure instanceof TestTimeoutError || failure.code === 'TEST_TIMEOUT') {
        record.status = 'timed-out';
      } else {
        record.status = 'failed';
      }
      record.error = serializeError(failure, { phase: reportPhase });
    }
    return record;
  }
}
