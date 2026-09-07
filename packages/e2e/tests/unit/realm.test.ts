import { describe, expect, it } from 'vitest';
import { collectModule, test } from '../../src/collect/registry.ts';
import type { TestTargetPair } from '../../src/collect/select.ts';
import { RealmManager, findRegistered, type Realm } from '../../src/run/realm.ts';
import type { RunError } from '../../src/run/records.ts';

/**
 * The hook lifecycle contract, checked on the realm
 * manager alone: no browser, no runner. The integration suite in
 * runner-lifecycle.test.ts proves the executor drives these in the right
 * places; this file pins the ordering rules themselves.
 */

const noop = async () => {};

function manager(runErrors: RunError[] = [], timeouts = { timeout: 1000, cleanupTimeout: 1000 }) {
  return new RealmManager({ targetName: 'web', platform: 'web', runErrors, ...timeouts });
}

/** The pairs still to run, as `leaveFinished` sees them: only the title path matters here. */
function remaining(realm: Realm, ...titlePaths: string[][]): TestTargetPair[] {
  return titlePaths.map((titlePath) => {
    const collected = { titlePath };
    if (findRegistered(realm, collected as never) === undefined) {
      throw new Error(`unknown test ${titlePath.join(' > ')}`);
    }
    return { test: collected } as unknown as TestTargetPair;
  });
}

function registered(realm: Realm, ...titlePath: string[]) {
  const found = findRegistered(realm, { titlePath } as never);
  if (found === undefined) throw new Error(`unknown test ${titlePath.join(' > ')}`);
  return found;
}

describe('realm hook lifecycle', () => {
  it('orders per-test hooks by scope nesting, not by position in the file', async () => {
    const log: string[] = [];
    const realm = manager().adopt(
      await collectModule(async () => {
        test.describe('group', () => {
          test.beforeEach(() => void log.push('beforeEach:group'));
          test.afterEach(() => void log.push('afterEach:group'));
          test.describe('inner', () => {
            test.beforeEach(() => void log.push('beforeEach:inner'));
            test.afterEach(() => void log.push('afterEach:inner'));
            test('t', noop);
          });
          // Declared after the nested group: still this scope's hook, after the earlier one.
          test.beforeEach(() => void log.push('beforeEach:group-late'));
          test.afterEach(() => void log.push('afterEach:group-late'));
        });
        // File-scope hooks declared below every group still run outermost.
        test.beforeEach(() => void log.push('beforeEach:file'));
        test.afterEach(() => void log.push('afterEach:file'));
      }),
    );
    const target = registered(realm, 'group', 'inner', 't');
    const fixtures = {} as never;
    for (const hook of manager().hooksFor(realm, target, 'beforeEach')) await hook.fn(fixtures);
    for (const hook of manager().hooksFor(realm, target, 'afterEach')) await hook.fn(fixtures);
    expect(log).toEqual([
      'beforeEach:file',
      'beforeEach:group',
      'beforeEach:group-late',
      'beforeEach:inner',
      'afterEach:inner',
      'afterEach:group-late',
      'afterEach:group',
      'afterEach:file',
    ]);
  });

  it('closes a scope when no remaining test needs it, innermost first, and keeps same-titled siblings apart', async () => {
    const log: string[] = [];
    const realms = manager();
    const realm = realms.adopt(
      await collectModule(async () => {
        test.beforeAll(() => void log.push('beforeAll:file'));
        test.afterAll(() => void log.push('afterAll:file'));
        test.describe('A', () => {
          test.beforeAll(() => void log.push('beforeAll:A'));
          test.afterAll(() => void log.push('afterAll:A'));
          test.afterAll(() => void log.push('afterAll:A-late'));
          test.describe('inner', () => {
            test.beforeAll(() => void log.push('beforeAll:inner'));
            test.afterAll(() => void log.push('afterAll:inner'));
            test('a1', noop);
          });
          test('a2', noop);
        });
        // A second group titled "A" is a scope of its own.
        test.describe('A', () => {
          test.beforeAll(() => void log.push('beforeAll:A2'));
          test.afterAll(() => void log.push('afterAll:A2'));
          test('a3', noop);
        });
      }),
    );

    expect(await realms.enterScopes(realm, registered(realm, 'A', 'inner', 'a1'))).toBeUndefined();
    log.push('body:a1');
    await realms.leaveFinished(realm, remaining(realm, ['A', 'a2'], ['A', 'a3']));

    expect(await realms.enterScopes(realm, registered(realm, 'A', 'a2'))).toBeUndefined();
    log.push('body:a2');
    await realms.leaveFinished(realm, remaining(realm, ['A', 'a3']));

    expect(await realms.enterScopes(realm, registered(realm, 'A', 'a3'))).toBeUndefined();
    log.push('body:a3');
    await realms.leaveFinished(realm, []);

    expect(log).toEqual([
      'beforeAll:file',
      'beforeAll:A',
      'beforeAll:inner',
      'body:a1',
      'afterAll:inner',
      'body:a2',
      // Teardown hooks of one scope run in reverse declaration order.
      'afterAll:A-late',
      'afterAll:A',
      'beforeAll:A2',
      'body:a3',
      'afterAll:A2',
      'afterAll:file',
    ]);
    expect(realm.entered.size).toBe(0);
  });

  it('reports a failed beforeAll for the scope, skips its later tests, and still runs afterAll', async () => {
    const log: string[] = [];
    const runErrors: RunError[] = [];
    const realms = manager(runErrors);
    const realm = realms.adopt(
      await collectModule(async () => {
        test.describe('broken', () => {
          test.beforeAll(() => {
            throw new Error('suite setup exploded');
          });
          test.beforeAll(() => void log.push('beforeAll:never'));
          test.afterAll(() => void log.push('afterAll:broken'));
          test('one', noop);
          test('two', noop);
        });
        test('independent', noop);
      }),
    );

    const failure = await realms.enterScopes(realm, registered(realm, 'broken', 'one'));
    expect(failure).toMatchObject({ code: 'HOOK_FAILED', phase: 'beforeAll', scopeId: 'broken' });
    expect(failure?.message).toContain('suite setup exploded');
    // The scope stays entered as failed: the next test in it is skipped by the same failure.
    expect(await realms.enterScopes(realm, registered(realm, 'broken', 'two'))).toBe(failure);
    // An unrelated scope is unaffected.
    expect(await realms.enterScopes(realm, registered(realm, 'independent'))).toBeUndefined();
    await realms.leave(realm);
    expect(log).toEqual(['afterAll:broken']);
    expect(runErrors.map((entry) => entry.error.scopeId)).toEqual(['broken']);
  });

  it('reports the first afterAll failure after still running every remaining teardown hook', async () => {
    const log: string[] = [];
    const runErrors: RunError[] = [];
    const realms = manager(runErrors);
    const realm = realms.adopt(
      await collectModule(async () => {
        test.afterAll(() => void log.push('afterAll:file'));
        test.describe('group', () => {
          test.afterAll(() => void log.push('afterAll:group-first'));
          test.afterAll(() => {
            throw new Error('teardown exploded');
          });
          test('t', noop);
        });
      }),
    );
    await realms.enterScopes(realm, registered(realm, 'group', 't'));
    const failure = await realms.leaveFinished(realm, []);
    expect(failure).toMatchObject({ code: 'HOOK_FAILED', phase: 'afterAll', scopeId: 'group' });
    expect(failure?.message).toContain('teardown exploded');
    expect(log).toEqual(['afterAll:group-first', 'afterAll:file']);
    expect(runErrors.map((entry) => entry.error)).toEqual([failure]);
  });

  it('times out suite hooks against their budgets and names the file scope', async () => {
    const runErrors: RunError[] = [];
    const realms = manager(runErrors, { timeout: 20, cleanupTimeout: 20 });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const realm = realms.adopt(
      await collectModule(async () => {
        test.beforeAll(() => sleep(500));
        test.afterAll(() => sleep(500));
        test('t', noop);
      }),
    );
    const failure = await realms.enterScopes(realm, registered(realm, 't'));
    expect(failure?.message).toContain('beforeAll hook timed out');
    await realms.leave(realm);
    expect(runErrors.map((entry) => [entry.error.phase, entry.error.scopeId])).toEqual([
      ['beforeAll', 'file'],
      ['afterAll', 'file'],
    ]);
    expect(runErrors[1]!.error.message).toContain('afterAll hook timed out');
  });
});
