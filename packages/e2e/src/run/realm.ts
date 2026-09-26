/** Suite realm lifecycle: module re-import, beforeAll/afterAll scope tracking. */

import { importModule } from '../config/load.ts';
import {
  classifyError,
  E2EError,
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
 * caller cancel what it started.
 */
export function runHook(
  label: string,
  run: () => void | Promise<void>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<void> {
  return withTimeout(
    Promise.resolve().then(run),
    timeoutMs,
    () => {
      onTimeout?.();
      return new TestTimeoutError(`${label} timed out`);
    },
  );
}

export interface RealmManagerOptions {
  readonly targetName: string;
  readonly platform: string;
  readonly timeout: number;
  readonly cleanupTimeout: number;
  /** Run-level error sink for hook failures. */
  readonly runErrors: RunError[];
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

  /** Enters suite scopes for a test, running pending beforeAll hooks. */
  async enterScopes(realm: Realm, test: RegisteredTest): Promise<SerializedError | undefined> {
    for (const scope of scopeChainFor(test)) {
      const entered = realm.entered.get(scope);
      if (entered !== undefined) {
        if (entered.failed !== undefined) return entered.failed;
        continue;
      }
      let failed: SerializedError | undefined;
      for (const hook of this.scopeHooks<SuiteHook>(realm, scope, 'beforeAll')) {
        try {
          await runHook(`${hook.kind} hook`, () => hook.fn(this.suiteFixtures()), this.options.timeout);
        } catch (cause) {
          const error = classifyError(cause);
          failed = serializeError(
            new E2EError('test', 'HOOK_FAILED', `beforeAll failed: ${error.message}`, { cause }),
            this.hookScope(realm, scope, 'beforeAll'),
          );
          this.options.runErrors.push({ error: failed });
          break;
        }
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
      for (const hook of this.scopeHooks<SuiteHook>(realm, scope, 'afterAll').toReversed()) {
        try {
          await runHook(`${hook.kind} hook`, () => hook.fn(this.suiteFixtures()), this.options.cleanupTimeout);
        } catch (cause) {
          const error = classifyError(cause);
          const failed = serializeError(
            new E2EError('test', 'HOOK_FAILED', `afterAll failed: ${error.message}`, { cause }),
            this.hookScope(realm, scope, 'afterAll'),
          );
          this.options.runErrors.push({ error: failed });
          failure ??= failed;
        }
      }
    }
    return failure;
  }

  /** Closes every entered scope: the realm ends here. */
  async leave(realm: Realm): Promise<void> {
    await this.leaveFinished(realm, []);
  }

  /**
   * Where a suite hook failed: its phase, and the scope, file, and target
   * whose tests `--last-failed` runs again, since a hook failure is a run
   * error that no test result carries.
   */
  private hookScope(realm: Realm, scope: Scope, phase: 'beforeAll' | 'afterAll') {
    return { phase, scopeId: scopeId(scope), file: realm.file, targetId: this.options.targetName };
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

  private suiteFixtures(): SuiteFixtures {
    return { platform: this.options.platform };
  }
}

/** The scope's report identity: its title path, or `file` for the file scope. */
function scopeId(scope: Scope): string {
  return scope === undefined ? 'file' : groupTitles(scope).join(' \u203a ');
}

function scopeChainFor(test: RegisteredTest): Scope[] {
  return [undefined, ...groupChain(test.group)];
}
