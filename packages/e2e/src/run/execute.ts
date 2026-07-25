/** Test-target execution engine (spec 11-lifecycle.md). */

import path from 'node:path';
import type { Driver, DriverSession, OperationContext } from '../driver/index.js';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.js';
import {
  classifyError,
  ConfigurationError,
  E2EError,
  InfrastructureError,
  serializeError,
  TestTimeoutError,
  type SerializedError,
} from '../internal/errors.js';
import { canonicalDigest, timestamp, uuidv7 } from '../internal/ids.js';
import { Deadline, withTimeout } from '../internal/time.js';
import type { CollectedFile, CollectedTest } from '../collect/collect.js';
import type { RegisteredTest } from '../collect/registry.js';
import type { SkipInfo, TestTargetPair } from '../collect/select.js';
import { createAttemptArtifacts, sanitizePathSegment } from './artifacts.js';
import { createFixtures, type ArtifactSink } from './fixtures.js';
import { findRegistered, RealmManager, type Realm } from './realm.js';
import type {
  AttemptRecord,
  ResultRecord,
  ResultStatus,
  RunError,
  SerialGroupRecord,
} from './records.js';
import { runSerialUnit, type SerialHost, type SharedSerialSession } from './serial.js';
import { SessionStaging, SessionStore, type SessionIdentity } from './sessions.js';
import { StepRecorder } from './steps.js';
import type { SetupFn, TestFn } from '../types.js';

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
}

export interface ExecutionOutcome {
  readonly results: readonly ResultRecord[];
  readonly serialGroups: readonly SerialGroupRecord[];
  readonly runErrors: readonly RunError[];
  readonly interrupted: boolean;
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
  readonly events?: ExecutionEvents;
}

type AttemptPhase = 'launch' | 'beforeEach' | 'body' | 'afterEach';

/** Executes every selected pair for one target sequentially. */
export class TargetExecutor {
  private readonly results: ResultRecord[] = [];
  private readonly serialGroups: SerialGroupRecord[] = [];
  private readonly runErrors: RunError[] = [];
  private readonly realms: RealmManager;
  private failedSetupSessions = new Map<string, string>();

  constructor(private readonly options: TargetExecutorOptions) {
    this.realms = new RealmManager({
      targetName: options.target.name,
      platform: options.target.platform,
      timeout: options.config.timeout,
      cleanupTimeout: options.config.cleanupTimeout,
      runErrors: this.runErrors,
    });
  }

  private get config(): ResolvedConfig {
    return this.options.config;
  }

  private emit(result: ResultRecord): void {
    this.results.push(result);
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

  private sessionIdentity(): SessionIdentity {
    return {
      targetId: this.options.target.name,
      driverId: this.options.driver.id,
      driverVersion: this.options.driver.version,
      spiVersion: this.options.driver.spiVersion,
      platform: this.options.target.platform,
      appIdentity: canonicalDigest({
        origin: this.config.app.base.origin,
        basePath: this.config.app.base.basePath,
        environment: this.config.app.environment,
      }),
    };
  }

  private serialHost(): SerialHost {
    return {
      target: this.options.target,
      artifactsRoot: this.options.artifactsRoot,
      interruptSignal: this.options.interruptSignal,
      realms: this.realms,
      launchSession: (pair, attemptId, artifactsDir, signal) =>
        this.launchSession(pair, attemptId, artifactsDir, signal),
      closeSession: (session, attemptId, record, sink, secondaryErrors) =>
        this.closeSession(session, attemptId, record, sink, secondaryErrors),
      runAttempt: (pair, registered, realm, attemptIndex, shared) =>
        this.runAttempt(pair, registered, realm, attemptIndex, undefined, shared),
      emit: (result) => this.emit(result),
    };
  }

  /** Runs all pairs for this target in report order. */
  async run(pairs: readonly TestTargetPair[], files: readonly CollectedFile[]): Promise<ExecutionOutcome> {
    const byTarget = pairs.filter((pair) => pair.target.name === this.options.target.name);

    const setupPairs = byTarget.filter((pair) => pair.test.kind === 'setup' && pair.disposition === 'run');
    for (const pair of setupPairs) {
      if (this.options.interruptSignal.aborted) break;
      await this.runSetupPair(pair);
    }

    const executedSerialUnits = new Set<string>();
    for (const file of files) {
      if (this.options.interruptSignal.aborted) break;
      const filePairs = byTarget.filter(
        (pair) => pair.test.file === file.file && pair.test.kind === 'test',
      );
      let realm: Realm | null = null;
      for (const pair of filePairs.sort((a, b) => a.test.declarationIndex - b.test.declarationIndex)) {
        if (this.options.interruptSignal.aborted) {
          this.emitUnstartedInterrupted(pair);
          continue;
        }
        if (pair.disposition !== 'run') {
          this.emitNonRun(pair);
          continue;
        }
        const dependencyFailure = this.dependencySkip(pair);
        if (dependencyFailure !== undefined) {
          this.emit({
            test: pair.test,
            target: pair.target,
            status: 'skipped',
            selected: true,
            skip: dependencyFailure,
            attempts: [],
          });
          continue;
        }
        if (pair.test.serialId !== undefined) {
          if (!executedSerialUnits.has(pair.test.serialId)) {
            executedSerialUnits.add(pair.test.serialId);
            const members = filePairs
              .filter((member) => member.test.serialId === pair.test.serialId)
              .sort((a, b) => a.test.declarationIndex - b.test.declarationIndex);
            this.serialGroups.push(await runSerialUnit(this.serialHost(), members, file));
            realm = null;
          }
          continue;
        }
        const outcome = await this.runOrdinaryPair(pair, file, realm);
        realm = outcome.realm;
      }
      if (realm !== null) await this.realms.leave(realm);
    }

    return {
      results: this.results,
      serialGroups: this.serialGroups,
      runErrors: this.runErrors,
      interrupted: this.options.interruptSignal.aborted,
    };
  }

  private emitNonRun(pair: TestTargetPair): void {
    if (pair.disposition === 'skip') {
      this.emit({
        test: pair.test,
        target: pair.target,
        status: 'skipped',
        selected: true,
        skip: pair.skip,
        attempts: [],
      });
      return;
    }
    this.emit({
      test: pair.test,
      target: pair.target,
      status: 'skipped',
      selected: false,
      skip: pair.skip ?? { cause: 'filtered', reason: 'not selected' },
      attempts: [],
    });
  }

  private emitUnstartedInterrupted(pair: TestTargetPair): void {
    this.emit({
      test: pair.test,
      target: pair.target,
      status: 'skipped',
      selected: pair.disposition === 'run',
      skip: { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' },
      attempts: [],
    });
  }

  private dependencySkip(pair: TestTargetPair): SkipInfo | undefined {
    const session = pair.options.session;
    if (session === undefined) return undefined;
    const failedSetup = this.failedSetupSessions.get(session);
    if (failedSetup === undefined) return undefined;
    return { cause: 'setup-failed', reason: `setup for session "${session}" failed`, relatedId: failedSetup };
  }

  private recordDisappeared(test: CollectedTest, message: string): void {
    this.runErrors.push({
      error: serializeError(new ConfigurationError('COLLECTION_ERROR', message), {
        phase: 'collection',
      }),
    });
  }

  // --- ordinary tests ---

  private async runOrdinaryPair(
    pair: TestTargetPair,
    file: CollectedFile,
    incomingRealm: Realm | null,
  ): Promise<{ realm: Realm | null }> {
    const attempts: AttemptRecord[] = [];
    const maxAttempts = pair.options.retries + 1;
    let realm = incomingRealm;
    let finalStatus: ResultStatus = 'failed';

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      if (this.options.interruptSignal.aborted) break;
      if (realm === null) realm = await this.realms.create(file);

      const registered = findRegistered(realm, pair.test);
      if (registered === undefined) {
        this.recordDisappeared(
          pair.test,
          `test ${pair.test.id} disappeared on re-import; registration must be deterministic`,
        );
        break;
      }

      const hookFailure = await this.realms.enterScopes(realm, registered);
      if (hookFailure !== undefined) {
        this.emit({
          test: pair.test,
          target: pair.target,
          status: 'skipped',
          selected: true,
          skip: { cause: 'hook-failed', reason: hookFailure.message },
          attempts: [],
        });
        return { realm };
      }

      const attempt = await this.runAttempt(pair, registered, realm, attemptIndex, undefined);
      attempts.push(attempt);

      if (attempt.status === 'passed') {
        finalStatus = passedStatus(attempts);
        break;
      }
      if (attempt.status === 'interrupted') {
        finalStatus = 'interrupted';
        realm = null;
        break;
      }
      finalStatus = attempt.status;
      realm = null;
      if (!isRetryEligible(attempt)) break;
    }

    this.emit({
      test: pair.test,
      target: pair.target,
      status: finalStatus,
      selected: true,
      attempts,
    });
    return { realm };
  }

  // --- setup tests ---

  private async runSetupPair(pair: TestTargetPair): Promise<void> {
    const file: CollectedFile = {
      file: pair.test.file,
      absolutePath: path.resolve(this.config.projectRoot, pair.test.file),
      registration: { tests: [], hooks: [] },
      tests: [],
    };
    const attempts: AttemptRecord[] = [];
    const maxAttempts = pair.options.retries + 1;
    let finalStatus: ResultStatus = 'failed';

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      if (this.options.interruptSignal.aborted) break;
      const realm = await this.realms.create(file);
      const registered = findRegistered(realm, pair.test);
      if (registered === undefined) {
        this.recordDisappeared(pair.test, `setup ${pair.test.id} disappeared on re-import`);
        break;
      }
      const staging = new SessionStaging(pair.test.sessions);
      const attempt = await this.runAttempt(pair, registered, realm, attemptIndex, staging);
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
          finalStatus = 'failed';
          continue;
        }
        for (const [name, state] of staging.entries()) {
          await this.options.sessionStore.save(name, this.sessionIdentity(), state);
        }
        finalStatus = passedStatus(attempts);
        break;
      }
      if (attempt.status === 'interrupted') {
        finalStatus = 'interrupted';
        break;
      }
      finalStatus = attempt.status;
      if (!isRetryEligible(attempt)) break;
    }

    if (finalStatus !== 'passed' && finalStatus !== 'flaky') {
      for (const session of pair.test.sessions) {
        this.failedSetupSessions.set(session, pair.test.id);
      }
    }
    this.emit({
      test: pair.test,
      target: pair.target,
      status: finalStatus,
      selected: true,
      attempts,
    });
  }

  // --- attempt core ---

  /** Launches one driver session, restores a configured session, and starts tracing. */
  private async launchSession(
    pair: TestTargetPair,
    attemptId: string,
    artifactsDir: string,
    signal: AbortSignal,
  ): Promise<DriverSession> {
    const driverSession = await withTimeout(
      this.options.driver.launch({
        target: this.options.target.driverTarget,
        targetId: this.options.target.name,
        app: {
          baseUrl: this.config.app.base.href,
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
    );

    if (pair.options.session !== undefined) {
      const state = await this.options.sessionStore.load(pair.options.session, this.sessionIdentity());
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

  /** Finalizes trace and closes the driver session with a fresh cleanup budget. */
  private async closeSession(
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
      await withTimeout(
        driverSession.close(this.op(attemptId, this.config.cleanupTimeout)),
        this.config.cleanupTimeout,
        () => new InfrastructureError('CLEANUP_TIMEOUT', 'driver close timed out'),
      );
    } catch (cause) {
      record.cleanup = 'failed';
      secondaryErrors.push(serializeError(classifyError(cause), { phase: 'cleanup' }));
    }
  }

  private async runAttempt(
    pair: TestTargetPair,
    registered: RegisteredTest,
    realm: Realm,
    attemptIndex: number,
    staging: SessionStaging | undefined,
    shared?: SharedSerialSession,
  ): Promise<AttemptRecord> {
    const attemptId = uuidv7();
    const startedAt = timestamp();
    const startedMs = Date.now();
    const steps = new StepRecorder(attemptId);
    const secondaryErrors: SerializedError[] = [];
    const attemptAbort = new AbortController();
    const onInterrupt = () => attemptAbort.abort();
    this.options.interruptSignal.addEventListener('abort', onInterrupt, { once: true });

    const artifacts = createAttemptArtifacts({
      artifactsRoot: this.options.artifactsRoot,
      segments: [this.options.target.name, sanitizePathSegment(pair.test.id), `attempt-${attemptIndex}`],
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
      if (shared !== undefined) {
        driverSession = shared.session;
      } else {
        driverSession = await this.launchSession(pair, attemptId, artifacts.dir, attemptAbort.signal);
      }

      const testDeadline = new Deadline(pair.options.timeout);
      const { fixtures } = createFixtures({
        config: this.config,
        target: this.options.target,
        driverSession,
        steps,
        signal: attemptAbort.signal,
        runId: this.options.runId,
        attemptId,
        testDeadline,
        artifacts: artifacts.sink,
        ...(shared !== undefined ? { opened: shared.opened } : {}),
        ...(staging !== undefined
          ? {
              saveSession: async (name: string) => {
                if (driverSession!.captureState === undefined) {
                  throw new ConfigurationError(
                    'UNSUPPORTED_CAPABILITY',
                    'driver does not support state capture',
                  );
                }
                const state = await driverSession!.captureState(
                  this.op(attemptId, this.config.actionTimeout, attemptAbort.signal),
                );
                staging.stage(name, state);
              },
            }
          : {}),
      });

      const beforeEachHooks = this.realms.hooksFor(realm, registered, 'beforeEach');
      const afterEachHooks = this.realms.hooksFor(realm, registered, 'afterEach').reverse();

      const mainWork = async (): Promise<void> => {
        phase = 'beforeEach';
        for (const hook of beforeEachHooks) {
          await (hook.fn as TestFn)(fixtures);
        }
        phase = 'body';
        await (registered.fn as SetupFn)(fixtures);
      };

      try {
        await withTimeout(mainWork(), Math.max(1, testDeadline.remaining()), () => {
          timedOut = true;
          attemptAbort.abort();
          return new TestTimeoutError(
            `test timed out after ${pair.options.timeout} ms in phase ${phase}`,
          );
        });
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
      this.options.interruptSignal.removeEventListener('abort', onInterrupt);
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
      if (this.options.interruptSignal.aborted && !timedOut) {
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

/** Final status for a passing retry loop: flaky when any earlier attempt failed. */
function passedStatus(attempts: readonly AttemptRecord[]): ResultStatus {
  return attempts.some((prior) => prior.status !== 'passed') ? 'flaky' : 'passed';
}

/** Only test-category failures and timeouts consume retry budget. */
function isRetryEligible(attempt: AttemptRecord): boolean {
  return (
    attempt.status === 'timed-out' ||
    (attempt.error !== undefined && attempt.error.category === 'test')
  );
}
