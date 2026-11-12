import { describe, expect, it } from 'vitest';
import { collectModule, test } from '../../src/collect/registry.ts';
import { InfrastructureError, TestError } from '../../src/internal/errors.ts';
import type { TestTargetPair } from '../../src/collect/select.ts';
import { RealmManager, findRegistered, type OpenSuiteHookSession, type Realm } from '../../src/run/realm.ts';
import type { RunError } from '../../src/run/records.ts';

/**
 * The hook lifecycle contract, checked on the realm
 * manager alone: no browser, no runner. The integration suite in
 * runner-lifecycle.test.ts proves the executor drives these in the right
 * places; this file pins the ordering rules themselves.
 */

const noop = async () => {};

/** The test module every realm here stands for; `collectModule` never reads it. */
const FILE = { file: 'tests/realm.e2e.ts', absolutePath: '/project/tests/realm.e2e.ts' };

/** A hook session that hands out `platform` alone and starts nothing. */
const openPlatformOnly: OpenSuiteHookSession = () => ({
  fixtures: { platform: 'web' } as never,
  enter: () => ({ cancel: () => {}, leave: noop }),
  close: noop,
});

function manager(
  runErrors: RunError[] = [],
  timeouts = { timeout: 1000, cleanupTimeout: 1000 },
  openHookSession = openPlatformOnly,
  interruptSignal = new AbortController().signal,
) {
  return new RealmManager({ targetName: 'web', runErrors, redactTitle: (title) => title, openHookSession, interruptSignal, ...timeouts });
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
      FILE,
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
      FILE,
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
      FILE,
    );

    const failure = await realms.enterScopes(realm, registered(realm, 'broken', 'one'));
    expect(failure).toMatchObject({ code: 'HOOK_FAILED', phase: 'beforeAll', scopeId: 'broken', scope: { file: 'tests/realm.e2e.ts', targetId: 'web', titlePath: ['broken'] } });
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
      FILE,
    );
    await realms.enterScopes(realm, registered(realm, 'group', 't'));
    const failure = await realms.leaveFinished(realm, []);
    expect(failure).toMatchObject({ code: 'HOOK_FAILED', phase: 'afterAll', scopeId: 'group', scope: { file: 'tests/realm.e2e.ts', targetId: 'web', titlePath: ['group'] } });
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
      FILE,
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

  it('serves a scope\'s hooks from one hook session, each hook in a turn of its own, and closes it after a failing hook', async () => {
    const log: string[] = [];
    const runErrors: RunError[] = [];
    const realms = manager(runErrors, undefined, (phase) => {
      log.push(`open:${phase}`);
      return {
        fixtures: { platform: 'web' } as never,
        enter: () => {
          log.push('enter');
          return { cancel: () => void log.push('cancel'), leave: async () => void log.push('leave') };
        },
        close: async () => void log.push(`close:${phase}`),
      };
    });
    const realm = realms.adopt(
      await collectModule(async () => {
        test.describe('group', () => {
          test.beforeAll(() => void log.push('beforeAll:1'));
          test.beforeAll(() => {
            throw new Error('setup exploded');
          });
          test.beforeAll(() => void log.push('never runs'));
          test.afterAll(() => void log.push('afterAll'));
          test('t', noop);
        });
        test.describe('plain', () => {
          test('no hooks', noop);
        });
      }),
      FILE,
    );
    expect((await realms.enterScopes(realm, registered(realm, 'group', 't')))?.message).toContain('setup exploded');
    await realms.leaveFinished(realm, remaining(realm, ['plain', 'no hooks']));
    // A scope without suite hooks opens nothing.
    expect(await realms.enterScopes(realm, registered(realm, 'plain', 'no hooks'))).toBeUndefined();
    expect(log).toEqual([
      'open:beforeAll', 'enter', 'beforeAll:1', 'leave', 'enter', 'leave', 'close:beforeAll',
      'open:afterAll', 'enter', 'afterAll', 'leave', 'close:afterAll',
    ]);
    expect(runErrors.map((entry) => [entry.error.phase, entry.error.scopeId, entry.error.category])).toEqual([['beforeAll', 'group', 'test']]);
  });

  it('cancels a hook that overruns, fails a hook that left a step running, and keeps an infrastructure failure\'s category', async () => {
    const runErrors: RunError[] = [];
    const cancelled: string[] = [];
    let turns = 0;
    const realms = manager(runErrors, { timeout: 20, cleanupTimeout: 20 }, (phase) => {
      if (phase === 'afterAll') throw new InfrastructureError('LAUNCH_TIMEOUT', 'starting an attempt timed out');
      return {
        fixtures: { platform: 'web' } as never,
        enter: () => {
          const turn = (turns += 1);
          return {
            cancel: () => void cancelled.push(`turn ${turn}`),
            leave: async () => {
              if (turn === 2) throw new TestError('STEP_NOT_AWAITED', 'the beforeAll hook returned before app.open "/" finished');
            },
          };
        },
        close: noop,
      };
    });
    const realm = realms.adopt(
      await collectModule(async () => {
        test.describe('slow', () => {
          test.beforeAll(() => new Promise<void>(() => {}));
          test('t', noop);
        });
        test.describe('unawaited', () => {
          test.beforeAll(noop);
          test.afterAll(noop);
          test('u', noop);
        });
      }),
      FILE,
    );
    expect((await realms.enterScopes(realm, registered(realm, 'slow', 't')))?.message).toContain('beforeAll hook timed out');
    expect(cancelled).toEqual(['turn 1']);
    expect((await realms.enterScopes(realm, registered(realm, 'unawaited', 'u')))?.message).toContain('returned before app.open');
    await realms.leave(realm);
    expect(runErrors.map((entry) => [entry.error.phase, entry.error.scopeId, entry.error.code, entry.error.category])).toEqual([
      ['beforeAll', 'slow', 'HOOK_FAILED', 'test'],
      ['beforeAll', 'unawaited', 'HOOK_FAILED', 'test'],
      ['afterAll', 'unawaited', 'HOOK_FAILED', 'infrastructure'],
    ]);
  });

  it('adds no run error for a hook whose fixture call the run\'s interrupt cancelled, and keeps its scope closed', async () => {
    const runErrors: RunError[] = [];
    const interrupt = new AbortController();
    const realms = manager(runErrors, undefined, undefined, interrupt.signal);
    const realm = realms.adopt(
      await collectModule(async () => {
        test.describe('group', () => {
          test.beforeAll(() => {
            throw new InfrastructureError('CANCELLED', 'operation cancelled');
          });
          test('t', noop);
        });
      }),
      FILE,
    );
    interrupt.abort({ cause: 'max-failures', reason: 'stopped after 1 failure' });
    expect(await realms.enterScopes(realm, registered(realm, 'group', 't'))).toMatchObject({
      code: 'INTERRUPTED',
      message: 'run interrupted in phase beforeAll: stopped after 1 failure',
    });
    expect(runErrors).toEqual([]);
  });
});
