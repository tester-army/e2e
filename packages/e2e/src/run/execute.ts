/** Test-target execution engine (spec 11-lifecycle.md). */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Driver, DriverSession, DriverState } from '../driver/index.js';
import { importModule } from '../config/load.js';
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
import {
  collectModule,
  type GroupNode,
  type ModuleRegistration,
  type RegisteredHook,
  type RegisteredTest,
} from '../collect/registry.js';
import type { SkipInfo, TestTargetPair } from '../collect/select.js';
import { createFixtures, type ArtifactSink } from './fixtures.js';
import { SessionStore, type SessionIdentity } from './sessions.js';
import { StepRecorder, type StepRecord } from './steps.js';
import type { SetupFn, SuiteFixtures, TestFn } from '../types.js';

export type ArtifactProducer = { kind: 'step'; stepId: string } | { kind: 'attempt' };

export interface ArtifactRecord {
  id: string;
  kind: 'screenshot' | 'trace' | 'video' | 'download';
  mediaType: string;
  path?: string;
  size?: number;
  sha256?: string;
  redaction: 'none' | 'complete';
  producer: ArtifactProducer;
}

export interface AttemptRecord {
  id: string;
  index: number;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
  secondaryErrors: SerializedError[];
  cleanup: 'complete' | 'failed' | 'forced';
}

export interface SerialMemberRecord {
  id: string;
  index: number;
  testId: string;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  error?: SerializedError;
  skip?: SkipInfo;
  secondaryErrors: SerializedError[];
}

export interface SerialAttemptRecord {
  id: string;
  index: number;
  status: 'passed' | 'failed' | 'timed-out' | 'interrupted';
  startedAt: string;
  durationMs: number;
  members: SerialMemberRecord[];
  artifacts: ArtifactRecord[];
  error?: SerializedError;
  secondaryErrors: SerializedError[];
  cleanup: 'complete' | 'failed' | 'forced';
}

export interface SerialGroupRecord {
  id: string;
  serialId: string;
  declarationIndex: number;
  file: string;
  titlePath: string[];
  targetId: string;
  platform: string;
  memberTestIds: string[];
  status: 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
  skip?: SkipInfo;
  attempts: SerialAttemptRecord[];
}

export type ResultStatus = 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';

export interface ResultRecord {
  test: CollectedTest;
  target: ResolvedTarget;
  status: ResultStatus;
  selected: boolean;
  skip?: SkipInfo | undefined;
  attempts: AttemptRecord[];
  serialGroupId?: string;
}

export interface RunError {
  error: SerializedError;
}

export interface ExecutionEvents {
  onResult?(result: ResultRecord): void;
}

export interface ExecutionOutcome {
  readonly results: readonly ResultRecord[];
  readonly serialGroups: readonly SerialGroupRecord[];
  readonly runErrors: readonly RunError[];
  readonly interrupted: boolean;
}

interface Realm {
  registration: ModuleRegistration;
  /** Scope keys whose beforeAll already ran in this realm. */
  entered: Map<string, { failed: SerializedError | undefined }>;
  /** Scopes pending afterAll, innermost last. */
  pendingAfterAll: string[];
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

/** Executes every selected pair for one target sequentially. */
export class TargetExecutor {
  private readonly results: ResultRecord[] = [];
  private readonly serialGroups: SerialGroupRecord[] = [];
  private readonly runErrors: RunError[] = [];
  private realmCounter = 0;
  private failedSetupSessions = new Map<string, string>();

  constructor(private readonly options: TargetExecutorOptions) {}

  private get config(): ResolvedConfig {
    return this.options.config;
  }

  private emit(result: ResultRecord): void {
    this.results.push(result);
    this.options.events?.onResult?.(result);
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
            await this.runSerialUnit(members, file);
            realm = null;
          }
          continue;
        }
        const outcome = await this.runOrdinaryPair(pair, file, realm);
        realm = outcome.realm;
      }
      if (realm !== null) await this.leaveRealm(realm);
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

  // --- realms ---

  private async createRealm(file: CollectedFile): Promise<Realm> {
    this.realmCounter += 1;
    const registration = await collectModule(() =>
      importModule(file.absolutePath, `${this.options.target.name}-${this.realmCounter}`),
    );
    return { registration, entered: new Map(), pendingAfterAll: [] };
  }

  private scopeKey(group: GroupNode | undefined): string {
    const titles: string[] = [];
    for (let node = group; node !== undefined; node = node.parent) titles.unshift(node.title);
    return titles.join('::');
  }

  private scopeChainFor(test: RegisteredTest): (GroupNode | undefined)[] {
    const chain: (GroupNode | undefined)[] = [undefined];
    const groups: GroupNode[] = [];
    for (let node = test.group; node !== undefined; node = node.parent) groups.unshift(node);
    chain.push(...groups);
    return chain;
  }

  private hooksFor(
    realm: Realm,
    test: RegisteredTest,
    kind: 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll',
    scope?: GroupNode | undefined,
    scopeOnly = false,
  ): RegisteredHook[] {
    const chainKeys = this.scopeChainFor(test).map((group) => this.scopeKey(group));
    return realm.registration.hooks.filter((hook) => {
      if (hook.kind !== kind) return false;
      const hookKey = this.scopeKey(hook.group);
      if (scopeOnly) return hookKey === this.scopeKey(scope);
      return chainKeys.includes(hookKey);
    });
  }

  private suiteFixtures(): SuiteFixtures {
    return { platform: this.options.target.platform };
  }

  /** Enters suite scopes for a test, running pending beforeAll hooks. */
  private async enterScopes(realm: Realm, test: RegisteredTest): Promise<SerializedError | undefined> {
    for (const scope of this.scopeChainFor(test)) {
      const key = this.scopeKey(scope);
      const entered = realm.entered.get(key);
      if (entered !== undefined) {
        if (entered.failed !== undefined) return entered.failed;
        continue;
      }
      const hooks = realm.registration.hooks.filter(
        (hook) => hook.kind === 'beforeAll' && this.scopeKey(hook.group) === key,
      );
      let failed: SerializedError | undefined;
      for (const hook of hooks) {
        try {
          await withTimeout(
            Promise.resolve(hook.fn(this.suiteFixtures() as never)),
            this.config.timeout,
            () => new TestTimeoutError('beforeAll hook timed out'),
          );
        } catch (cause) {
          const error = classifyError(cause);
          failed = serializeError(
            new E2EError('test', 'HOOK_FAILED', `beforeAll failed: ${error.message}`, { cause }),
            { phase: 'beforeAll', scopeId: key === '' ? (test.titlePath[0] ?? 'file') : key },
          );
          this.runErrors.push({ error: failed });
          break;
        }
      }
      realm.entered.set(key, { failed });
      realm.pendingAfterAll.push(key);
      if (failed !== undefined) return failed;
    }
    return undefined;
  }

  private async leaveRealm(realm: Realm): Promise<void> {
    for (const key of [...realm.pendingAfterAll].reverse()) {
      const hooks = realm.registration.hooks.filter(
        (hook) => hook.kind === 'afterAll' && this.scopeKey(hook.group) === key,
      );
      for (const hook of [...hooks].reverse()) {
        try {
          await withTimeout(
            Promise.resolve(hook.fn(this.suiteFixtures() as never)),
            this.config.cleanupTimeout,
            () => new TestTimeoutError('afterAll hook timed out'),
          );
        } catch (cause) {
          const error = classifyError(cause);
          this.runErrors.push({
            error: serializeError(
              new E2EError('test', 'HOOK_FAILED', `afterAll failed: ${error.message}`, { cause }),
              { phase: 'afterAll', scopeId: key },
            ),
          });
        }
      }
    }
    realm.pendingAfterAll = [];
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
      if (realm === null) realm = await this.createRealm(file);

      const registered = realm.registration.tests.find(
        (candidate) => candidate.titlePath.join('\u0000') === pair.test.titlePath.join('\u0000'),
      );
      if (registered === undefined) {
        this.runErrors.push({
          error: serializeError(
            new ConfigurationError(
              'COLLECTION_ERROR',
              `test ${pair.test.id} disappeared on re-import; registration must be deterministic`,
            ),
            { phase: 'collection' },
          ),
        });
        finalStatus = 'failed';
        break;
      }

      const hookFailure = await this.enterScopes(realm, registered);
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
        finalStatus = attempts.some((prior) => prior.status !== 'passed') ? 'flaky' : 'passed';
        break;
      }
      if (attempt.status === 'interrupted') {
        finalStatus = 'interrupted';
        realm = null;
        break;
      }
      finalStatus = attempt.status;
      realm = null;
      const retryEligible =
        attempt.status === 'timed-out' ||
        (attempt.error !== undefined && attempt.error.category === 'test');
      if (!retryEligible) break;
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
      const realm = await this.createRealm(file);
      const registered = realm.registration.tests.find(
        (candidate) => candidate.titlePath.join('\u0000') === pair.test.titlePath.join('\u0000'),
      );
      if (registered === undefined) {
        this.runErrors.push({
          error: serializeError(
            new ConfigurationError('COLLECTION_ERROR', `setup ${pair.test.id} disappeared on re-import`),
            { phase: 'collection' },
          ),
        });
        break;
      }
      const staged = new Map<string, DriverState>();
      const attempt = await this.runAttempt(pair, registered, realm, attemptIndex, staged);
      attempts.push(attempt);
      await this.leaveRealm(realm);

      if (attempt.status === 'passed') {
        const declared = new Set(pair.test.sessions);
        const savedNames = [...staged.keys()];
        const missing = [...declared].filter((name) => !staged.has(name));
        const undeclared = savedNames.filter((name) => !declared.has(name));
        if (missing.length > 0 || undeclared.length > 0) {
          attempt.status = 'failed';
          attempt.error = serializeError(
            new E2EError(
              'test',
              'SESSION_CONTRACT',
              `setup must save each declared session exactly once; missing: [${missing.join(', ')}], undeclared: [${undeclared.join(', ')}]`,
            ),
            { phase: 'body' },
          );
          finalStatus = 'failed';
          continue;
        }
        for (const [name, state] of staged) {
          await this.options.sessionStore.save(name, this.sessionIdentity(), state);
        }
        finalStatus = attempts.some((prior) => prior.status !== 'passed') ? 'flaky' : 'passed';
        break;
      }
      if (attempt.status === 'interrupted') {
        finalStatus = 'interrupted';
        break;
      }
      finalStatus = attempt.status;
      const retryEligible =
        attempt.status === 'timed-out' ||
        (attempt.error !== undefined && attempt.error.category === 'test');
      if (!retryEligible) break;
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
        target: rawTarget(this.options.target),
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
        operation: {
          signal,
          timeoutMs: this.config.launchTimeout,
          runId: this.options.runId,
          attemptId,
        },
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
      await driverSession.restoreState(state, {
        signal,
        timeoutMs: this.config.launchTimeout,
        runId: this.options.runId,
        attemptId,
      });
    }

    if (this.config.artifacts.includes('trace') && driverSession.artifacts.startTrace !== undefined) {
      await driverSession.artifacts
        .startTrace({
          signal,
          timeoutMs: this.config.launchTimeout,
          runId: this.options.runId,
          attemptId,
        })
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
        const tracePath = await driverSession.artifacts.stopTrace({
          signal: new AbortController().signal,
          timeoutMs: this.config.cleanupTimeout,
          runId: this.options.runId,
          attemptId,
        });
        artifactSink.register('trace', tracePath);
      } catch {
        // trace finalization is best-effort
      }
    }
    try {
      await withTimeout(
        driverSession.close({
          signal: new AbortController().signal,
          timeoutMs: this.config.cleanupTimeout,
          runId: this.options.runId,
          attemptId,
        }),
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
    sessionStaging: Map<string, DriverState> | undefined,
    sharedSession?: DriverSession,
  ): Promise<AttemptRecord> {
    const attemptId = uuidv7();
    const startedAt = timestamp();
    const startedMs = Date.now();
    const steps = new StepRecorder(attemptId);
    const artifacts: ArtifactRecord[] = [];
    const secondaryErrors: SerializedError[] = [];
    const attemptAbort = new AbortController();
    const onInterrupt = () => attemptAbort.abort();
    this.options.interruptSignal.addEventListener('abort', onInterrupt, { once: true });

    const artifactsDir = path.join(
      this.options.artifactsRoot,
      this.options.target.name,
      sanitizePathSegment(pair.test.id),
      `attempt-${attemptIndex}`,
    );
    mkdirSync(artifactsDir, { recursive: true });

    const record: AttemptRecord = {
      id: attemptId,
      index: attemptIndex,
      status: 'passed',
      startedAt,
      durationMs: 0,
      steps: [],
      artifacts,
      secondaryErrors,
      cleanup: 'complete',
    };

    const artifactSink: ArtifactSink = {
      register: (kind, relativePath) => {
        const id = `${attemptId}:artifact:${artifacts.length}`;
        const absolute = path.join(artifactsDir, relativePath);
        let size: number | undefined;
        let digest: string | undefined;
        try {
          size = statSync(absolute).size;
          digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        } catch {
          // artifact may not exist yet; recorded without size/digest
        }
        const reportPath = path.posix.join(
          this.options.target.name,
          sanitizePathSegment(pair.test.id),
          `attempt-${attemptIndex}`,
          relativePath,
        );
        const stepId = steps.currentStepId;
        artifacts.push({
          id,
          kind,
          mediaType: mediaTypeFor(relativePath),
          ...(size !== undefined && digest !== undefined
            ? { path: reportPath, size, sha256: digest }
            : {}),
          redaction: 'complete',
          producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
        });
        return id;
      },
    };

    let driverSession: DriverSession | null = null;
    let failure: E2EError | undefined;
    let phase: 'launch' | 'beforeEach' | 'body' | 'afterEach' = 'launch';
    let timedOut = false;

    try {
      if (sharedSession !== undefined) {
        driverSession = sharedSession;
      } else {
        driverSession = await this.launchSession(pair, attemptId, artifactsDir, attemptAbort.signal);
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
        artifacts: artifactSink,
        ...(sessionStaging !== undefined
          ? {
              saveSession: async (name: string) => {
                if (driverSession!.captureState === undefined) {
                  throw new ConfigurationError(
                    'UNSUPPORTED_CAPABILITY',
                    'driver does not support state capture',
                  );
                }
                const state = await driverSession!.captureState({
                  signal: attemptAbort.signal,
                  timeoutMs: this.config.actionTimeout,
                  runId: this.options.runId,
                  attemptId,
                });
                if (sessionStaging.has(name)) {
                  throw new E2EError('test', 'SESSION_CONTRACT', `session "${name}" saved twice`);
                }
                if (!registered.sessions.includes(name)) {
                  throw new E2EError(
                    'test',
                    'SESSION_CONTRACT',
                    `session "${name}" was not declared by this setup test`,
                  );
                }
                sessionStaging.set(name, state);
              },
            }
          : {}),
      });

      const beforeEachHooks = this.hooksFor(realm, registered, 'beforeEach');
      const afterEachHooks = this.hooksFor(realm, registered, 'afterEach').reverse();

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
      }

      const failedPhase = phase;
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
          } else {
            secondaryErrors.push(serializeError(hookError, { phase: 'afterEach' }));
          }
        }
      }
      phase = failure === undefined ? phase : failedPhase;
    } catch (cause) {
      failure = classifyError(cause);
    } finally {
      this.options.interruptSignal.removeEventListener('abort', onInterrupt);
      if (driverSession !== null && sharedSession === undefined) {
        await this.closeSession(driverSession, attemptId, record, artifactSink, secondaryErrors);
      }
    }

    record.durationMs = Date.now() - startedMs;
    record.steps = [...steps.all()];

    if (failure === undefined) {
      record.status = 'passed';
    } else if (this.options.interruptSignal.aborted && !timedOut) {
      record.status = 'interrupted';
      record.error = serializeError(failure, { phase });
    } else if (timedOut || failure instanceof TestTimeoutError || failure.code === 'TEST_TIMEOUT') {
      record.status = 'timed-out';
      record.error = serializeError(failure, { phase });
    } else {
      record.status = 'failed';
      record.error = serializeError(failure, { phase });
    }
    return record;
  }

  // --- serial units ---

  private async runSerialUnit(members: readonly TestTargetPair[], file: CollectedFile): Promise<void> {
    const first = members[0]!;
    const groupOptions = first.options;
    const serialId = first.test.serialId!;
    const groupTitlePath = serialTitlePath(first.test);
    const groupRecordId = canonicalDigest({ serialId, targetId: this.options.target.name });

    const group: SerialGroupRecord = {
      id: groupRecordId,
      serialId,
      declarationIndex: first.test.declarationIndex,
      file: first.test.file,
      titlePath: groupTitlePath,
      targetId: this.options.target.name,
      platform: this.options.target.platform,
      memberTestIds: members.map((member) => member.test.id),
      status: 'failed',
      attempts: [],
    };
    this.serialGroups.push(group);

    const maxAttempts = groupOptions.retries + 1;
    const memberFinalStatus = new Map<string, SerialMemberRecord>();

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      if (this.options.interruptSignal.aborted) break;
      const attempt = await this.runSerialAttempt(members, file, attemptIndex);
      group.attempts.push(attempt);
      for (const member of attempt.members) memberFinalStatus.set(member.testId, member);
      if (attempt.status === 'passed') break;
      if (attempt.status === 'interrupted') break;
    }

    const lastAttempt = group.attempts[group.attempts.length - 1];
    if (lastAttempt === undefined) {
      group.status = 'skipped';
      group.skip = { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' };
    } else if (lastAttempt.status === 'passed') {
      group.status = group.attempts.length > 1 ? 'flaky' : 'passed';
    } else {
      group.status = lastAttempt.status;
    }

    for (const member of members) {
      const memberRecord = memberFinalStatus.get(member.test.id);
      let status: ResultStatus;
      let skip: SkipInfo | undefined;
      if (group.status === 'passed' || group.status === 'flaky') {
        status = group.status;
      } else if (memberRecord === undefined) {
        status = 'skipped';
        skip = { cause: 'serial-predecessor-failed', reason: 'group attempt did not reach this member' };
      } else if (memberRecord.status === 'skipped') {
        status = 'skipped';
        skip = memberRecord.skip;
      } else {
        status = memberRecord.status;
      }
      this.emit({
        test: member.test,
        target: member.target,
        status,
        selected: true,
        ...(skip !== undefined ? { skip } : {}),
        attempts: [],
        serialGroupId: groupRecordId,
      });
    }
  }

  private async runSerialAttempt(
    members: readonly TestTargetPair[],
    file: CollectedFile,
    attemptIndex: number,
  ): Promise<SerialAttemptRecord> {
    const attemptId = uuidv7();
    const startedAt = timestamp();
    const startedMs = Date.now();
    const memberRecords: SerialMemberRecord[] = [];
    const record: SerialAttemptRecord = {
      id: attemptId,
      index: attemptIndex,
      status: 'passed',
      startedAt,
      durationMs: 0,
      members: memberRecords,
      artifacts: [],
      secondaryErrors: [],
      cleanup: 'complete',
    };

    let realm: Realm;
    try {
      realm = await this.createRealm(file);
    } catch (cause) {
      record.status = 'failed';
      record.error = serializeError(classifyError(cause), { phase: 'collection' });
      record.durationMs = Date.now() - startedMs;
      return record;
    }

    const first = members[0]!;
    const groupArtifactsDir = path.join(
      this.options.artifactsRoot,
      this.options.target.name,
      sanitizePathSegment(first.test.serialId ?? first.test.id),
      `attempt-${attemptIndex}`,
    );
    mkdirSync(groupArtifactsDir, { recursive: true });
    const groupArtifactSink: ArtifactSink = {
      register: (kind, relativePath) => {
        const id = `${attemptId}:artifact:${record.artifacts.length}`;
        const absolute = path.join(groupArtifactsDir, relativePath);
        let size: number | undefined;
        let digest: string | undefined;
        try {
          size = statSync(absolute).size;
          digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        } catch {
          // artifact may not exist; recorded without size/digest
        }
        record.artifacts.push({
          id,
          kind,
          mediaType: mediaTypeFor(relativePath),
          ...(size !== undefined && digest !== undefined
            ? {
                path: path.posix.join(
                  this.options.target.name,
                  sanitizePathSegment(first.test.serialId ?? first.test.id),
                  `attempt-${attemptIndex}`,
                  relativePath,
                ),
                size,
                sha256: digest,
              }
            : {}),
          redaction: 'complete',
          producer: { kind: 'attempt' },
        });
        return id;
      },
    };

    let sharedSession: DriverSession;
    try {
      sharedSession = await this.launchSession(
        first,
        attemptId,
        groupArtifactsDir,
        this.options.interruptSignal,
      );
    } catch (cause) {
      const error = classifyError(cause);
      record.status = 'failed';
      record.error = serializeError(error, { phase: 'launch' });
      for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
        memberRecords.push({
          id: `${attemptId}:member:${memberIndex}`,
          index: memberIndex,
          testId: members[memberIndex]!.test.id,
          status: 'skipped',
          startedAt: timestamp(),
          durationMs: 0,
          steps: [],
          skip: { cause: 'infrastructure-unavailable', reason: error.message },
          secondaryErrors: [],
        });
      }
      record.durationMs = Date.now() - startedMs;
      await this.leaveRealm(realm);
      return record;
    }

    let failedIndex = -1;
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const member = members[memberIndex]!;
      const memberId = `${attemptId}:member:${memberIndex}`;
      if (failedIndex >= 0 || this.options.interruptSignal.aborted) {
        memberRecords.push({
          id: memberId,
          index: memberIndex,
          testId: member.test.id,
          status: 'skipped',
          startedAt: timestamp(),
          durationMs: 0,
          steps: [],
          skip: {
            cause: 'serial-predecessor-failed',
            reason: `member ${failedIndex} failed in this group attempt`,
          },
          secondaryErrors: [],
        });
        continue;
      }
      const registered = realm.registration.tests.find(
        (candidate) => candidate.titlePath.join('\u0000') === member.test.titlePath.join('\u0000'),
      );
      if (registered === undefined) {
        failedIndex = memberIndex;
        memberRecords.push({
          id: memberId,
          index: memberIndex,
          testId: member.test.id,
          status: 'failed',
          startedAt: timestamp(),
          durationMs: 0,
          steps: [],
          error: serializeError(
            new ConfigurationError('COLLECTION_ERROR', 'member disappeared on re-import'),
          ),
          secondaryErrors: [],
        });
        continue;
      }
      const memberAttempt = await this.runAttempt(
        member,
        registered,
        realm,
        attemptIndex,
        undefined,
        sharedSession,
      );
      memberRecords.push({
        id: memberId,
        index: memberIndex,
        testId: member.test.id,
        status: memberAttempt.status,
        startedAt: memberAttempt.startedAt,
        durationMs: memberAttempt.durationMs,
        steps: memberAttempt.steps,
        ...(memberAttempt.error !== undefined ? { error: memberAttempt.error } : {}),
        secondaryErrors: memberAttempt.secondaryErrors,
      });
      record.artifacts.push(...memberAttempt.artifacts);
      if (memberAttempt.status !== 'passed') failedIndex = memberIndex;
    }
    await this.leaveRealm(realm);
    await this.closeSession(sharedSession, attemptId, record, groupArtifactSink, record.secondaryErrors);

    const failedMember = memberRecords.find((member) => member.status !== 'passed' && member.status !== 'skipped');
    if (this.options.interruptSignal.aborted) {
      record.status = 'interrupted';
    } else if (failedMember === undefined) {
      record.status = 'passed';
    } else {
      record.status = failedMember.status === 'skipped' ? 'failed' : failedMember.status as SerialAttemptRecord['status'];
      if (failedMember.error !== undefined) record.error = failedMember.error;
    }
    record.durationMs = Date.now() - startedMs;
    return record;
  }
}

function serialTitlePath(test: CollectedTest): string[] {
  const serialRoot = test.serialRoot;
  const titles: string[] = [];
  for (let node = serialRoot; node !== undefined; node = node.parent) titles.unshift(node.title);
  return titles.length === 0 ? [test.title] : titles;
}

function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._\-]/g, '_').slice(0, 120);
}

function mediaTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.zip')) return 'application/zip';
  if (relativePath.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

function rawTarget(target: ResolvedTarget): import('../types.js').Target {
  return {
    name: target.name,
    platform: 'web',
    browser: target.browser,
    ...(target.viewport !== undefined ? { viewport: target.viewport } : {}),
  };
}
