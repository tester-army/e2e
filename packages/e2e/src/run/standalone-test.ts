/**
 * One collected test run on a standalone attempt: `e2e mcp`'s
 * `open_session {test}`. The test's `beforeAll` and `beforeEach` hooks, its
 * `test.extend()` fixtures, and its body run on the attempt's fixtures under
 * the test's timeout, the way a worker runs them, and the attempt then stays
 * where the body stopped, passed or failed, so a coding agent can look at the
 * screen the test ended on. Teardown (`afterEach` hooks, fixture teardowns,
 * `afterAll` hooks) waits for the attempt's close. The replay cache serves
 * the run as it serves a run's first attempt, settled when the body ends.
 */

import { isModelUnreachable } from '../agent/error.ts';
import { settleStagedTraces, type AgentCacheContext } from '../cache/context.ts';
import { collect, type CollectedFile, type TestIdentity } from '../collect/collect.ts';
import { select, type TestTargetPair } from '../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { OperationContext, TargetSession } from '../engine/surface.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { PollScope, runInPollScope } from '../expect/poll-scope.ts';
import { SoftFailures } from '../expect/soft.ts';
import {
  classifyError, ConfigurationError, E2EError, InfrastructureError, serializeError, TestError, TestTimeoutError, type ErrorPhase, type SerializedError,
} from '../internal/errors.ts';
import { isRuntimeSkip, type RuntimeSkip } from '../internal/skip.ts';
import { withAbort, withTimeout } from '../internal/time.ts';
import type { SetupFn } from '../types.ts';
import type { AttemptBudget } from './budget.ts';
import { classifyAttemptStatus, type TargetExecutor } from './execute.ts';
import { createExtendedFixtures, type ExtendedFixtures } from './extended-fixtures.ts';
import { captureFailureEvidence } from './failure-evidence.ts';
import type { ArtifactSink, AttemptFixtures } from './fixtures.ts';
import { findRegistered, runHook, type Realm } from './realm.ts';
import type { FailureEvidence } from './records.ts';
import { sessionLedger } from './secrecy.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

/** A queue: each piece of work starts once every piece queued before it has settled. */
function oneAtATime(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const turn = tail.then(work, work);
    tail = turn.catch(() => undefined);
    return turn;
  };
}

/**
 * Test code runs one turn at a time per process, a run's hooks and body or
 * its teardown: `expect.poll`, `expect.soft`, and `test.skip` find the running
 * attempt through one slot per process (`publishAttempt`), and a rejection
 * nobody handled is charged to the turn it lands in.
 */
const takeTurn = oneAtATime();
/** Collection takes one slot per process too (`collectModule`), and a file's top-level await can yield it. */
const collectAlone = oneAtATime();

/** The test `open_session {test}` runs, as `e2e run`'s collection and selection found it on the session's target. */
export interface StandaloneTest {
  readonly pair: TestTargetPair;
  /** The test's file as collection imported it; the attempt adopts that import as the test's realm. */
  readonly file: CollectedFile;
}

/** Tests a `TEST_AMBIGUOUS` message names before it counts the rest. */
const MAX_LISTED_TESTS = 10;

/**
 * Collects the project the way `e2e run <positional>` does and returns the one
 * test the positional selects on `target`. A positional that selects nothing
 * fails with `e2e run`'s `NO_TESTS` message, one that selects several with
 * `TEST_AMBIGUOUS` listing them, and a test a session cannot run alone with
 * `SESSION_TEST_UNSUPPORTED`: a serial group member, a test that starts from
 * a setup test's saved session, and a test that runs as several agents.
 * `graph` is the module graph the project's files load in, so an edit to a
 * file the test imports is seen by the next session.
 */
export async function selectStandaloneTest(
  config: ResolvedConfig,
  target: ResolvedTarget,
  positional: string,
  graph: string | undefined,
): Promise<StandaloneTest> {
  const collection = await collectAlone(() => collect(config, [positional], graph));
  const { pairs } = select(collection, config, { targetIds: [target.name] }, { noTestsHint: 'name a test file the config finds, alone when it holds one test, or with :line on the line its test( call is on, not a line inside the test' });
  // A serial group's other members run beside a selected one; only what the positional named counts.
  const runnable = pairs.filter((pair) => pair.disposition === 'run' && pair.test.kind === 'test' && pair.test.selected);
  const tests = [...new Map(runnable.map((pair) => [pair.test.id, pair.test])).values()];
  if (tests.length > 1) {
    const listed = tests.slice(0, MAX_LISTED_TESTS).map((test) => `${testLocation(test)} "${test.titlePath.join(' › ')}"`);
    const rest = tests.length - listed.length;
    throw new ConfigurationError(
      'TEST_AMBIGUOUS',
      `"${positional}" selects ${tests.length} tests on target "${target.name}", and a session runs one; name it as file:line: ${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`,
    );
  }
  const [pair, ...otherAgents] = runnable;
  if (pair === undefined) throw new ConfigurationError('NO_TESTS', `"${positional}" selects no test on target "${target.name}"`);
  const named = `test "${pair.test.titlePath.join(' › ')}" (${testLocation(pair.test)})`;
  if (pair.test.serialId !== undefined) {
    throw unsupported(`${named} is in a serial group, whose tests run in order on one shared attempt; a session runs a test alone, so run the group with npx e2e run`);
  }
  if (pair.options.session !== undefined) {
    throw unsupported(`${named} starts from session "${pair.options.session}", which a setup test saves first; a session does not run setup tests yet, so run it with npx e2e run`);
  }
  if (otherAgents.length > 0) {
    const agents = [pair, ...otherAgents].map((each) => `"${each.agent}"`).join(', ');
    throw unsupported(`${named} runs as agents ${agents}; a session runs one, so run it with npx e2e run`);
  }
  const file = collection.files.find((candidate) => candidate.file === pair.test.file);
  if (file === undefined) throw new ConfigurationError('NO_TESTS', `the file of ${named} was not collected`);
  return { pair, file };
}

/** `tests/a.e2e.ts:12`, the line the test is declared on, or the file alone when the declaration is in a module it imports. */
export function testLocation(test: Pick<TestIdentity, 'file' | 'source'>): string {
  return test.source === undefined ? test.file : `${test.file}:${test.source.line}`;
}

function unsupported(message: string): ConfigurationError {
  return new ConfigurationError('SESSION_TEST_UNSUPPORTED', message);
}

/** What a standalone test run reads of the attempt it runs on. */
interface StandaloneTestEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly executor: TargetExecutor;
  readonly runId: string;
  readonly attemptId: string;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  /** The test's own budget, which only `fixtures` read; the session's tools have another. */
  readonly budget: AttemptBudget;
  readonly fixtures: AttemptFixtures['fixtures'];
  readonly artifacts: ArtifactSink;
  readonly cache: AgentCacheContext | undefined;
  /** The attempt's cancellation: the body's budget and every teardown hook's follow it. */
  readonly signal: AbortSignal;
  readonly redact: (text: string) => string;
}

/** How the test's hooks and body ended. */
export interface StandaloneTestOutcome {
  readonly status: 'passed' | 'failed' | 'timed-out' | 'skipped' | 'interrupted';
  readonly error?: SerializedError | undefined;
  /** Failures that landed after the first: a step the body did not await, soft assertions beside a thrown one. */
  readonly secondaryErrors: readonly SerializedError[];
  readonly skipReason?: string | undefined;
  /** What the screen held when the failure landed: the URL, and the nodes nearest a locator that matched nothing. */
  readonly failure?: FailureEvidence | undefined;
  readonly durationMs: number;
  readonly steps: readonly StepRecord[];
}

export interface StandaloneTestRun {
  readonly test: StandaloneTest;
  /** Runs the test's hooks and body, once; the attempt stays where the body stopped. */
  run(): Promise<StandaloneTestOutcome>;
  /**
   * Runs what the body left set up: `afterEach` hooks, fixture teardowns, then
   * `afterAll` hooks. Once, after the run settled; nothing when it never
   * started. Never rejects: every failure is returned, `afterAll`'s through
   * the worker's run errors.
   */
  teardown(): Promise<readonly SerializedError[]>;
}

/** The phases a standalone run moves through before its teardown. */
type RunPhase = 'beforeAll' | 'beforeEach' | 'body';

/** What a run leaves for its teardown: the realm whose scopes it entered, and the `afterEach` hooks then the fixture teardowns, in order. */
interface Started {
  readonly realm: Realm;
  readonly teardowns: readonly { readonly label: string; readonly run: () => Promise<void> | void }[];
}

/** Where a rejection nobody handled goes while test code takes its turn. */
let strayInTurn: ((cause: unknown) => void) | undefined;
/** Runs whose turn ended and whose teardown has not, oldest first: a promise their test left can still reject. */
const liveRuns: { readonly late: (cause: unknown) => void }[] = [];
/** The test the run that ended last ran, which a rejection landing once every such session closed most likely came from. */
let lastTest: string | undefined;

/**
 * Takes a rejection nobody in the process handled once a session has run a
 * test, as a run's worker does once a test has run: test code taking its
 * turn fails with it, the way a body cut short by its timeout does; between
 * turns the newest run still open reports it at its close; and once every
 * such session closed, `warn` tells the operator. False before any session
 * ran a test, so the caller treats it as any uncaught error.
 */
export function claimStrayRejection(cause: unknown, warn: (message: string) => void): boolean {
  if (strayInTurn !== undefined) {
    strayInTurn(cause);
    return true;
  }
  const newest = liveRuns.at(-1);
  if (newest !== undefined) {
    newest.late(cause);
    return true;
  }
  if (lastTest === undefined) return false;
  warn(`a promise rejected after its session closed, most likely left by test "${lastTest}": ${classifyError(cause).message}`);
  return true;
}

/** Binds one test to an attempt; nothing runs until `run`. */
export function createStandaloneTestRun(env: StandaloneTestEnvironment, test: StandaloneTest): StandaloneTestRun {
  const { config, executor, steps, budget, attemptId } = env;
  let ran: Promise<Started | undefined> | undefined;
  /** Whether the run's turn came; a teardown before then leaves nothing to tear down. */
  let begun = false;
  let tearingDown: Promise<readonly SerializedError[]> | undefined;
  const serialize = (cause: unknown, phase: ErrorPhase): SerializedError =>
    serializeError(classifyError(cause), { phase, projectRoot: config.projectRoot, redact: env.redact });
  /** What a promise the test left rejected with after its turn ended. */
  const lateErrors: SerializedError[] = [];
  const self = {
    late: (cause: unknown): void => {
      const error = new TestError(
        'UNHANDLED_REJECTION',
        `a promise rejected after the test's body ended, most likely left by "${test.pair.test.titlePath.join(' › ')}": ${classifyError(cause).message}`,
        { cause },
      );
      lateErrors.push(serialize(error, 'body'));
    },
  };
  const operation = (signal: AbortSignal, timeoutMs: number): OperationContext => ({ signal, timeoutMs, runId: env.runId, attemptId, origin: 'test' });

  const execute = async (): Promise<{ started: Started | undefined; outcome: StandaloneTestOutcome }> => {
    const startedMs = Date.now();
    const { pair } = test;
    const realm = executor.realms.adopt(test.file.registration, test.file);
    const registered = findRegistered(realm, pair.test);
    if (registered === undefined) throw new ConfigurationError('COLLECTION_ERROR', `test ${pair.test.id} is no longer registered by ${pair.test.file}`);
    const secondaryErrors: SerializedError[] = [];
    let failure: E2EError | undefined;
    let failurePhase: RunPhase = 'beforeAll';
    let skipped: RuntimeSkip | undefined;
    let timedOut = false;
    // As in a run's attempt: confirmation stops at what was verified when the
    // failure landed, and a failure only a missing model explains implicates nothing.
    let lastVerifiedAtFailure = -1;
    let implicatesUnconfirmed = false;
    const fail = (cause: unknown, phase: RunPhase): void => {
      const classified = classifyError(cause);
      if (!isModelUnreachable(classified)) implicatesUnconfirmed = true;
      if (failure !== undefined) {
        secondaryErrors.push(serialize(classified, phase));
        return;
      }
      lastVerifiedAtFailure = steps.lastVerifiedStepIndex;
      failure = classified;
      failurePhase = phase;
    };
    let phase: RunPhase = 'beforeAll';
    /** How many steps the test had recorded when its body ended; a body cut short that runs on records more. */
    let stepsRan: number | undefined;
    /** Ends the body the way its timeout does, while the body's race is pending. */
    let cutBody: ((cause: unknown) => void) | undefined;
    // A rejection nobody handled is charged to this turn, as a run's worker charges the attempt in flight.
    strayInTurn = (cause) => (cutBody === undefined ? fail(cause, phase) : cutBody(cause));

    const hookFailure = await executor.realms.enterScopes(realm, registered);
    let extended: ExtendedFixtures | undefined;
    if (hookFailure !== undefined) {
      fail(new E2EError('test', hookFailure.code, hookFailure.message), 'beforeAll');
    } else {
      // The test's own timeout bounds its hooks and body.
      const bodyAbort = budget.enter(env.signal, pair.options.timeout);
      const soft = new SoftFailures();
      const polls = new PollScope('the test body');
      const publication = new AbortController();
      publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls }, publication.signal);
      // Whatever happens below, the slot is free for the next test once the body is done.
      try {
        extended = createExtendedFixtures(registered.fixtures, env.fixtures, env.target.engine?.name ?? 'none', budget.signal);
        const fixtures = extended;
        /** Set once the body's race settled: a body cut short that runs on is no longer the test's to report. */
        let bodyOver = false;
        const enter = (next: RunPhase): void => {
          phase = next;
          steps.phase = next === 'beforeEach' ? 'beforeEach' : undefined;
        };
        /** Steps and polls the body left running, failed at their call and cancelled; see `executeAttempt`. */
        const abandonNotAwaited = async (): Promise<E2EError[]> => {
          if (bodyOver) return [];
          const pollsNotAwaited = polls.close();
          const stepsNotAwaited = steps.abandonRunning();
          if (stepsNotAwaited !== undefined) {
            bodyAbort.abort();
            await withTimeout(steps.settleAbandoned(), config.cleanupTimeout, () => new Error('abandoned steps did not settle')).catch(() => undefined);
          }
          return [stepsNotAwaited, pollsNotAwaited].filter((error) => error !== undefined);
        };
        const mainWork = async (): Promise<void> => {
          try {
            enter('beforeEach');
            await fixtures.setUp();
            budget.signal.throwIfAborted();
            for (const hook of executor.realms.hooksFor(realm, registered, 'beforeEach')) {
              await hook.fn(env.fixtures);
              budget.signal.throwIfAborted();
            }
            enter('body');
            await (registered.fn as SetupFn)(env.fixtures);
          } catch (cause) {
            const notAwaited = await abandonNotAwaited();
            if (isRuntimeSkip(cause)) throw cause;
            for (const secondary of [...notAwaited, soft.close()]) if (secondary !== undefined) secondaryErrors.push(serialize(secondary, 'body'));
            throw cause;
          }
          const [notAwaited, ...moreNotAwaited] = await abandonNotAwaited();
          for (const secondary of moreNotAwaited) secondaryErrors.push(serialize(secondary, 'body'));
          if (notAwaited !== undefined) throw notAwaited;
          const softFailure = soft.close();
          if (softFailure !== undefined) throw softFailure;
        };
        const work = runInPollScope(polls, mainWork);
        const body = Promise.race([
          work,
          new Promise<never>((_, reject) => {
            cutBody = (cause) => {
              bodyAbort.abort();
              reject(cause);
            };
          }),
        ]);
        try {
          await withTimeout(body, Math.max(1, pair.options.timeout), () => {
            timedOut = true;
            bodyAbort.abort();
            return new TestTimeoutError(`test timed out after ${pair.options.timeout} ms in phase ${phase}`);
          });
        } catch (cause) {
          polls.close();
          if (isRuntimeSkip(cause)) skipped = cause;
          else fail(cause, phase);
        } finally {
          cutBody = undefined;
          bodyOver = true;
          stepsRan = steps.all().length;
        }
        // A body cut short still runs until it reaches a harness call, which
        // fails on its aborted budget; it gets the cleanup budget to get there
        // while the turn is still its own.
        await withTimeout(work, config.cleanupTimeout, () => new Error('the test body did not stop')).catch(() => undefined);
        // A rejection the body left unawaited lands once the microtasks drain.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const lateSoft = soft.close();
        if (lateSoft !== undefined) fail(lateSoft, 'body');
        // A callback the engine ran for the body (a route handler) fails on a path no step awaits.
        try {
          await executor.settleAttempt(env.session, attemptId);
        } catch (cause) {
          fail(cause, 'body');
        }
      } finally {
        steps.phase = undefined;
        publication.abort();
      }
    }

    const interrupted = env.signal.aborted;
    const status: StandaloneTestOutcome['status'] =
      failure === undefined ? (skipped === undefined ? 'passed' : 'skipped') : classifyAttemptStatus(failure, timedOut, interrupted);
    // The verdict stands: what lands from here on is noted beside it.
    strayInTurn = (cause) => secondaryErrors.push(serialize(cause, 'body'));
    let evidence: FailureEvidence | undefined;
    if (failure !== undefined && !interrupted) {
      evidence = await captureFailureEvidence({
        session: env.session,
        error: failure,
        ledger: sessionLedger(env.session, config.allSecrets),
        config,
        appOrigin: env.target.app.base?.origin,
        artifacts: env.artifacts,
        operation,
        interrupt: env.signal,
      }).catch(() => undefined);
    }
    if (env.cache !== undefined) {
      await settleStagedTraces(
        env.cache,
        status === 'interrupted'
          ? undefined
          : {
              lastVerifiedStepIndex: failure === undefined ? steps.lastVerifiedStepIndex : lastVerifiedAtFailure,
              implicatesUnconfirmed: failure === undefined || implicatesUnconfirmed,
            },
      );
    }
    // Parked until teardown: a body that outlived its turn finds every harness call refused.
    budget.enter(env.signal, 1).abort();
    const outcome: StandaloneTestOutcome = {
      status,
      ...(failure === undefined ? {} : { error: serialize(failure, failurePhase) }),
      secondaryErrors,
      ...(skipped === undefined ? {} : { skipReason: skipped.reason }),
      ...(evidence === undefined ? {} : { failure: evidence }),
      durationMs: Date.now() - startedMs,
      steps: steps.all().slice(0, stepsRan),
    };
    const teardowns =
      extended === undefined
        ? []
        : [
            ...executor.realms.hooksFor(realm, registered, 'afterEach').map((hook) => ({ label: `${hook.kind} hook`, run: () => hook.fn(env.fixtures) })),
            ...extended.teardowns().map((teardown) => ({ label: `fixture "${teardown.name}" teardown`, run: teardown.run })),
          ];
    return { started: { realm, teardowns }, outcome };
  };

  const run = (): Promise<StandaloneTestOutcome> => {
    if (ran !== undefined) return Promise.reject(new ConfigurationError('WORKER_PROTOCOL', 'the session already ran its test'));
    const executed = takeTurn(async () => {
      // A session closed or cancelled while it waited for its turn runs none of the test's code.
      if (tearingDown !== undefined || env.signal.aborted) throw new InfrastructureError('CANCELLED', 'the session ended before its test ran');
      begun = true;
      lastTest = test.pair.test.titlePath.join(' › ');
      try {
        const result = await execute();
        if (result.started !== undefined) liveRuns.push(self);
        return result;
      } finally {
        strayInTurn = undefined;
      }
    });
    ran = executed.then((result) => result.started, () => undefined);
    return withAbort(executed.then((result) => result.outcome), env.signal, () => new InfrastructureError('CANCELLED', 'the session was cancelled while its test ran'));
  };

  const teardown = (): Promise<readonly SerializedError[]> => {
    tearingDown ??= (async () => {
      if (!begun) return [];
      const started = await ran;
      if (started === undefined) return lateErrors;
      return takeTurn(async () => {
        const errors: SerializedError[] = [];
        strayInTurn = (cause) => errors.push(serialize(cause, 'afterEach'));
        const soft = new SoftFailures();
        // As after a run's body: a soft matcher in a teardown hook finds the collection closed.
        soft.close();
        const publication = new AbortController();
        try {
          publishAttempt({ attemptId, owner: 'host', testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls: new PollScope('the test teardown') }, publication.signal);
          steps.phase = 'afterEach';
          // Each teardown gets its own cleanup budget, as in a run's attempt.
          for (const hook of started.teardowns) {
            const hookAbort = budget.enter(env.signal, config.cleanupTimeout);
            try {
              await runHook(hook.label, hook.run, config.cleanupTimeout, () => hookAbort.abort());
            } catch (cause) {
              errors.push(serialize(cause, 'afterEach'));
            }
          }
          await executor.settleAttempt(env.session, attemptId).catch((cause: unknown) => errors.push(serialize(cause, 'afterEach')));
          await executor.realms.leave(started.realm).catch((cause: unknown) => errors.push(serialize(cause, 'afterAll')));
        } finally {
          steps.phase = undefined;
          publication.abort();
          strayInTurn = undefined;
          const live = liveRuns.indexOf(self);
          if (live !== -1) liveRuns.splice(live, 1);
        }
        return [...lateErrors, ...errors];
      }).catch((cause: unknown) => [...lateErrors, serialize(cause, 'cleanup')]);
    })();
    return tearingDown;
  };

  return { test, run, teardown };
}
