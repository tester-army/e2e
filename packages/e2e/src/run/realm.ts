/** Suite realm lifecycle: module re-import, beforeAll/afterAll scope tracking. */

import { importModule } from '../config/load.js';
import {
  classifyError,
  E2EError,
  serializeError,
  TestTimeoutError,
  type SerializedError,
} from '../internal/errors.js';
import { withTimeout } from '../internal/time.js';
import type { CollectedFile, CollectedTest } from '../collect/collect.js';
import {
  collectModule,
  type GroupNode,
  type ModuleRegistration,
  type RegisteredHook,
  type RegisteredTest,
} from '../collect/registry.js';
import type { Platform, SuiteFixtures } from '../types.js';
import type { RunError } from './records.js';

export interface Realm {
  registration: ModuleRegistration;
  /** Scope keys whose beforeAll already ran in this realm. */
  entered: Map<string, { failed: SerializedError | undefined }>;
  /** Scopes pending afterAll, innermost last. */
  pendingAfterAll: string[];
}

/** Finds a registered test in a re-imported realm by its exact title path. */
export function findRegistered(realm: Realm, test: CollectedTest): RegisteredTest | undefined {
  const key = test.titlePath.join('\u0000');
  return realm.registration.tests.find(
    (candidate) => candidate.titlePath.join('\u0000') === key,
  );
}

export interface RealmManagerOptions {
  readonly targetName: string;
  readonly platform: Platform;
  readonly timeout: number;
  readonly cleanupTimeout: number;
  /** Run-level error sink for hook failures. */
  readonly runErrors: RunError[];
}

/** Creates realms and runs suite-scope hooks with per-realm entry tracking. */
export class RealmManager {
  private realmCounter = 0;

  constructor(private readonly options: RealmManagerOptions) {}

  /** Re-imports one test module in a fresh realm. */
  async create(file: CollectedFile): Promise<Realm> {
    this.realmCounter += 1;
    const registration = await collectModule(() =>
      importModule(file.absolutePath, `${this.options.targetName}-${this.realmCounter}`),
    );
    return { registration, entered: new Map(), pendingAfterAll: [] };
  }

  /** Returns a test's hooks of one kind across its enclosing scope chain. */
  hooksFor(realm: Realm, test: RegisteredTest, kind: 'beforeEach' | 'afterEach'): RegisteredHook[] {
    const chainKeys = scopeChainFor(test).map(scopeKey);
    return realm.registration.hooks.filter(
      (hook) => hook.kind === kind && chainKeys.includes(scopeKey(hook.group)),
    );
  }

  /** Enters suite scopes for a test, running pending beforeAll hooks. */
  async enterScopes(realm: Realm, test: RegisteredTest): Promise<SerializedError | undefined> {
    for (const scope of scopeChainFor(test)) {
      const key = scopeKey(scope);
      const entered = realm.entered.get(key);
      if (entered !== undefined) {
        if (entered.failed !== undefined) return entered.failed;
        continue;
      }
      const hooks = realm.registration.hooks.filter(
        (hook) => hook.kind === 'beforeAll' && scopeKey(hook.group) === key,
      );
      let failed: SerializedError | undefined;
      for (const hook of hooks) {
        try {
          await withTimeout(
            Promise.resolve(hook.fn(this.suiteFixtures() as never)),
            this.options.timeout,
            () => new TestTimeoutError('beforeAll hook timed out'),
          );
        } catch (cause) {
          const error = classifyError(cause);
          failed = serializeError(
            new E2EError('test', 'HOOK_FAILED', `beforeAll failed: ${error.message}`, { cause }),
            { phase: 'beforeAll', scopeId: key === '' ? (test.titlePath[0] ?? 'file') : key },
          );
          this.options.runErrors.push({ error: failed });
          break;
        }
      }
      realm.entered.set(key, { failed });
      realm.pendingAfterAll.push(key);
      if (failed !== undefined) return failed;
    }
    return undefined;
  }

  /** Runs pending afterAll hooks, innermost scope first. */
  async leave(realm: Realm): Promise<void> {
    for (const key of [...realm.pendingAfterAll].reverse()) {
      const hooks = realm.registration.hooks.filter(
        (hook) => hook.kind === 'afterAll' && scopeKey(hook.group) === key,
      );
      for (const hook of [...hooks].reverse()) {
        try {
          await withTimeout(
            Promise.resolve(hook.fn(this.suiteFixtures() as never)),
            this.options.cleanupTimeout,
            () => new TestTimeoutError('afterAll hook timed out'),
          );
        } catch (cause) {
          const error = classifyError(cause);
          this.options.runErrors.push({
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

  private suiteFixtures(): SuiteFixtures {
    return { platform: this.options.platform };
  }
}

function scopeKey(group: GroupNode | undefined): string {
  const titles: string[] = [];
  for (let node = group; node !== undefined; node = node.parent) titles.unshift(node.title);
  return titles.join('::');
}

function scopeChainFor(test: RegisteredTest): (GroupNode | undefined)[] {
  const chain: (GroupNode | undefined)[] = [undefined];
  const groups: GroupNode[] = [];
  for (let node = test.group; node !== undefined; node = node.parent) groups.unshift(node);
  chain.push(...groups);
  return chain;
}
