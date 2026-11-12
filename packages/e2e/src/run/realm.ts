/** Suite realm lifecycle: module re-import, beforeAll/afterAll scope tracking. */

import { importModule } from '../config/load.ts';
import { PollScope, runInPollScope } from '../expect/poll-scope.ts';
import {
  classifyError,
  E2EError,
  InfrastructureError,
  serializeError,
  TestTimeoutError,
  type SerializedError,
} from '../internal/errors.ts';
import { DebugTrace } from '../internal/debug.ts';
import { titlePathKey } from '../internal/ids.ts';
import { withTimeout } from '../internal/time.ts';
import type { CollectedFile, CollectedTest } from '../collect/collect.ts';
import {
  collectModule,
  groupChain,
  groupTitles,
  type GroupNode,
  type ModuleRegistration,
  type RegisteredHook,
  type RegisteredTest,
  type SuiteHook,
  type TestHook,
} from '../collect/registry.ts';
import type { TestTargetPair } from '../collect/select.ts';
import type { SuiteFixtures } from '../types.ts';
import type { RunError } from './records.ts';
import { interruptedInPhase } from './units.ts';

/**
 * A suite scope of one realm: a describe group, or `undefined` for the file
 * scope. Scopes are the registration's own group nodes, so two sibling groups
 * that happen to share a title stay two scopes with their own hooks.
 */
type Scope = GroupNode | undefined;

/** The test module a realm imports: the project-relative path its results carry, and where it is on disk. */
export type FileRef = Pick<CollectedFile, 'file' | 'absolutePath'>;

export interface Realm {
  /** The project-relative test file, which a hook failure names so a rerun can find its scope's tests. */
  file: string;
  registration: ModuleRegistration;
  /** Registered tests by title-path key, for per-attempt lookup. */
  testsByKey: ReadonlyMap<string, RegisteredTest>;
  /**
   * Scopes whose beforeAll ran in this realm, in entry order (outermost
   * first), each with the failure that ended its beforeAll if one did. A scope
   * leaves the map when its afterAll has run.
   */
  entered: Map<Scope, { failed: SerializedError | undefined }>;
}

/** Finds a registered test in a re-imported realm by its exact title path. */
export function findRegistered(realm: Realm, test: CollectedTest): RegisteredTest | undefined {
  return realm.testsByKey.get(titlePathKey(test.titlePath));
}

/**
 * Runs one hook, or a fixture teardown, within its budget. One that overruns
 * fails with the runner's timeout error naming `label`; `onTimeout` lets the
 * caller cancel what it started. The hook owns the `expect.poll` calls it
 * starts: one still running when it returns fails it with
 * `STEP_NOT_AWAITED` and is cancelled, and one left by a hook that failed is
 * cancelled beside that failure. `starting` names a start the hook may be
 * waiting on (a hook attempt's), whose time is not the hook's.
 */
export async function runHook(
  label: string,
  run: () => void | Promise<void>,
  timeoutMs: number,
  onTimeout?: () => void,
  starting?: () => Promise<unknown> | undefined,
): Promise<void> {
  const polls = new PollScope(`the ${label}`);
  const work = runInPollScope(polls, () => Promise.resolve().then(run));
  const overrun = (): Error => {
    onTimeout?.();
    return new TestTimeoutError(`${label} timed out`);
  };
  try {
    await (starting === undefined ? withTimeout(work, timeoutMs, overrun) : withTimeoutAfter(starting, work, timeoutMs, overrun));
  } catch (cause) {
    polls.close();
    throw cause;
  }
  const notAwaited = polls.close();
  if (notAwaited !== undefined) throw notAwaited;
}

/**
 * `withTimeout` for a hook that may be waiting on a start: a timer that
 * fires while `starting()` names one in flight waits for it, then runs again
 * in full. The start has a bound of its own (`launchTimeout`), so a slow one
 * fails as a launch, never as the hook's timeout.
 */
function withTimeoutAfter<T>(
  starting: () => Promise<unknown> | undefined,
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const arm = (): void => {
      if (settled) return;
      timer = setTimeout(() => {
        const start = starting();
        if (start === undefined) reject(onTimeout());
        else void start.then(arm, arm);
      }, timeoutMs);
    };
    arm();
    void work.then(resolve, reject).finally(() => {
      settled = true;
      clearTimeout(timer);
    });
  });
}

/** The fixtures one scope's suite hooks run with, and how to give back what they started. */
export interface SuiteHookSession {
  readonly fixtures: SuiteFixtures;
  /**
   * The start of what serves the fixtures (a hook attempt's launch) while it
   * is in flight. A hook's timeout does not run while it waits on one.
   */
  starting?(): Promise<unknown> | undefined;
  /**
   * Gives the next hook a budget of its own, as each `afterEach` hook has, so
   * a slow hook never spends the next one's.
   */
  enter(timeoutMs: number): SuiteHookTurn;
  /** Ends what the hooks started (a hook attempt); a failure here is the hooks' failure. */
  close(): Promise<void>;
}

/** One suite hook's turn on a hook session. */
export interface SuiteHookTurn {
  /** Cancels the operations the hook has running; called when the hook overruns its budget. */
  cancel(): void;
  /**
   * Called once the hook returned or failed. Rejects with `STEP_NOT_AWAITED`
   * for a step the hook started and never awaited, which it cancels.
   */
  leave(): Promise<void>;
}

/**
 * Hands out the fixtures for one scope's `beforeAll` or `afterAll` hooks.
 * Between test attempts the runner serves them from a hook attempt of its
 * own, which starts at the hooks' first step; a caller whose session is
 * already open (a serial group, a hosted test) serves them from it.
 */
export type OpenSuiteHookSession = (phase: 'beforeAll' | 'afterAll') => SuiteHookSession;

export interface RealmManagerOptions {
  readonly targetName: string;
  /** Where suite hooks get their fixtures when the caller names no other source. */
  readonly openHookSession: OpenSuiteHookSession;
  /** The run's interrupt: a hook fixture call it cancelled is not a hook failure. */
  readonly interruptSignal: AbortSignal;
  readonly timeout: number;
  readonly cleanupTimeout: number;
  /** Run-level error sink for hook failures. */
  readonly runErrors: RunError[];
  /** What collection rewrites titles with (`collectModule`), so a realm's tests match the collected ids. */
  readonly redactTitle: (title: string) => string;
  readonly debug?: DebugTrace;
}

/** Creates realms and runs suite-scope hooks with per-realm entry tracking. */
export class RealmManager {
  private realmCounter = 0;
  private readonly debug: DebugTrace;

  constructor(private readonly options: RealmManagerOptions) {
    this.debug = options.debug ?? new DebugTrace(false);
  }

  /** Re-imports one test module in a fresh realm. */
  async create(file: FileRef): Promise<Realm> {
    this.realmCounter += 1;
    const registration = await this.debug.time('realm.import', () =>
      collectModule(
        () => importModule(file.absolutePath, `${this.options.targetName}-${this.realmCounter}`),
        file.absolutePath,
        this.options.redactTitle,
      ),
    );
    return this.adopt(registration, file);
  }

  /**
   * Wraps a registration that was just imported and has run nothing yet as a
   * realm. The worker imports every unit's file once to resolve its pairs;
   * adopting that import saves the second, identical one per unit.
   */
  adopt(registration: ModuleRegistration, file: FileRef): Realm {
    const testsByKey = new Map<string, RegisteredTest>();
    for (const test of registration.tests) testsByKey.set(titlePathKey(test.titlePath), test);
    return { file: file.file, registration, testsByKey, entered: new Map() };
  }

  /**
   * A test's hooks of one kind in execution order.
   * `beforeEach` runs outer scope to inner, each scope's hooks in declaration
   * order, wherever in the file a scope's hooks were declared relative to the
   * test or to nested groups. `afterEach` mirrors it: inner scope to outer,
   * each scope's hooks in reverse declaration order.
   */
  hooksFor(realm: Realm, test: RegisteredTest, kind: TestHook['kind']): TestHook[] {
    const ordered = scopeChainFor(test).flatMap((scope) =>
      this.scopeHooks<TestHook>(realm, scope, kind),
    );
    return kind === 'beforeEach' ? ordered : ordered.toReversed();
  }

  /**
   * Enters suite scopes for a test, running pending beforeAll hooks. Each
   * scope with hooks opens one hook session for all of them; `open` overrides
   * the default source when the caller already holds a session.
   */
  async enterScopes(
    realm: Realm,
    test: RegisteredTest,
    open?: OpenSuiteHookSession,
  ): Promise<SerializedError | undefined> {
    for (const scope of scopeChainFor(test)) {
      const entered = realm.entered.get(scope);
      if (entered !== undefined) {
        if (entered.failed !== undefined) return entered.failed;
        continue;
      }
      const hooks = this.scopeHooks<SuiteHook>(realm, scope, 'beforeAll');
      let failed: SerializedError | undefined;
      if (hooks.length > 0) {
        const [cause] = await this.runSuiteHooks(hooks, 'beforeAll', this.options.timeout, open);
        if (cause !== undefined) failed = this.hookFailed(realm, scope, 'beforeAll', cause.error);
      }
      realm.entered.set(scope, { failed });
      if (failed !== undefined) return failed;
    }
    return undefined;
  }

  /**
   * Closes every entered scope that none of `remaining` (the pairs still to
   * run in this realm) belongs to, innermost first, running its afterAll
   * hooks in reverse declaration order. A scope's afterAll therefore runs
   * when its last runnable member leaves it, not when
   * the file ends: one describe's teardown never runs after a sibling's tests.
   *
   * Returns the first afterAll failure. Every failure is a run error, and the
   * remaining hooks and scopes still run; the caller decides what the realm
   * is still good for (spec: an afterAll failure discards the suite instance).
   */
  async leaveFinished(
    realm: Realm,
    remaining: readonly TestTargetPair[],
    open?: OpenSuiteHookSession,
  ): Promise<SerializedError | undefined> {
    let failure: SerializedError | undefined;
    const needed = new Set<Scope>();
    for (const pair of remaining) {
      // A pair the realm cannot find never runs here, so it holds nothing open.
      const registered = findRegistered(realm, pair.test);
      if (registered !== undefined) for (const scope of scopeChainFor(registered)) needed.add(scope);
    }
    for (const scope of [...realm.entered.keys()].toReversed()) {
      if (needed.has(scope)) continue;
      realm.entered.delete(scope);
      const hooks = this.scopeHooks<SuiteHook>(realm, scope, 'afterAll').toReversed();
      if (hooks.length === 0) continue;
      for (const cause of await this.runSuiteHooks(hooks, 'afterAll', this.options.cleanupTimeout, open)) {
        const failed = this.hookFailed(realm, scope, 'afterAll', cause.error);
        failure ??= failed;
      }
    }
    return failure;
  }

  /** Closes every entered scope: the realm ends here. */
  async leave(realm: Realm, open?: OpenSuiteHookSession): Promise<void> {
    await this.leaveFinished(realm, [], open);
  }

  /**
   * Runs one scope's suite hooks of one phase in one hook session, each
   * within a budget of `timeoutMs`, and returns their failures in order. A
   * `beforeAll` failure ends the scope's hooks; every `afterAll` hook runs
   * regardless. The session closes either way, and a session that would not
   * open or close is a failure too.
   */
  private async runSuiteHooks(
    hooks: readonly SuiteHook[],
    phase: 'beforeAll' | 'afterAll',
    timeoutMs: number,
    open: OpenSuiteHookSession = this.options.openHookSession,
  ): Promise<{ error: unknown }[]> {
    let session: SuiteHookSession;
    try {
      session = open(phase);
    } catch (error) {
      return [{ error }];
    }
    const failures: { error: unknown }[] = [];
    for (const hook of hooks) {
      const turn = session.enter(timeoutMs);
      // The hook's own failure is the verdict; a step it never awaited fails one that returned.
      let failure: { error: unknown } | undefined;
      try {
        await runHook(`${hook.kind} hook`, () => hook.fn(session.fixtures), timeoutMs, turn.cancel, () => session.starting?.());
      } catch (error) {
        failure = { error };
      }
      try {
        await turn.leave();
      } catch (error) {
        failure ??= { error };
      }
      if (failure === undefined) continue;
      failures.push(failure);
      if (phase === 'beforeAll') break;
    }
    try {
      await session.close();
    } catch (error) {
      failures.push({ error });
    }
    return failures;
  }

  /**
   * Records a suite hook failure as a run error. No test result carries it,
   * so it names its scope the way results do, for `--last-failed` to run
   * the tests in it again. A hook the infrastructure failed (an engine that
   * would not boot, a hook attempt that would not start or end) keeps that
   * category, and with it exit code 3, as the same failure in a test does.
   * A fixture call the run's interrupt cancelled is the interrupt's, as it is
   * in a test: the scope stays closed to its tests, and no run error is added.
   */
  private hookFailed(realm: Realm, scope: Scope, phase: 'beforeAll' | 'afterAll', cause: unknown): SerializedError {
    const classified = classifyError(cause);
    const context = {
      phase,
      scopeId: scopeId(scope),
      scope: { file: realm.file, targetId: this.options.targetName, titlePath: scope === undefined ? [] : groupTitles(scope) },
    };
    const { interruptSignal } = this.options;
    if (interruptSignal.aborted && classified.code === 'CANCELLED') {
      return serializeError(new E2EError('interrupted', 'INTERRUPTED', interruptedInPhase(interruptSignal, phase)), context);
    }
    const message = `${phase} failed: ${classified.message}`;
    const failed = serializeError(
      classified.category === 'infrastructure'
        ? new InfrastructureError('HOOK_FAILED', message, { cause })
        : new E2EError('test', 'HOOK_FAILED', message, { cause }),
      context,
    );
    this.options.runErrors.push({ error: failed });
    return failed;
  }

  /** One scope's hooks of one kind, in declaration order. */
  private scopeHooks<Hook extends RegisteredHook>(
    realm: Realm,
    scope: Scope,
    kind: Hook['kind'],
  ): Hook[] {
    return realm.registration.hooks.filter(
      (hook): hook is Hook => hook.kind === kind && hook.group === scope,
    );
  }
}

/** The scope's report identity: its title path, or `file` for the file scope. */
function scopeId(scope: Scope): string {
  return scope === undefined ? 'file' : groupTitles(scope).join(' \u203a ');
}

function scopeChainFor(test: RegisteredTest): Scope[] {
  return [undefined, ...groupChain(test.group)];
}
