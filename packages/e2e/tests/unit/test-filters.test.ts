/**
 * Test filters (`filters`): the selection kept when no filter is called, the
 * candidates a filter is handed and the setup file each one's session comes
 * from, filters composed in order, what a result may name and score and
 * every way one is refused, redaction and bounds on what a filter writes, how
 * a throw, an interrupt, or the deadline surfaces, the record and summary
 * line of what each one decided, and the notice for how many tests it ranked.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import { collectFromRegistration, type Collection } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { select } from '../../src/collect/select.ts';
import { resolveConfig, type ResolvedConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { ConfigurationError, type E2EError } from '../../src/internal/errors.ts';
import {
  applyTestFilters,
  FILTER_TIMEOUT_MS,
  filterCandidates,
  filterRecords,
  filterSelection,
  filterSummary,
  rankingNotice,
  type FilterSelectionOptions,
  type TestFilterScope,
} from '../../src/run/test-filters.ts';
import type { E2EConfig, TestFilter, TestFilterCandidate, TestFilterContext, TestFilterResult } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';

/** What `leaveWorkBehind` was told: a timeout records the work it left behind, for the CLI to exit on. */
const leaveWorkBehind = vi.hoisted(() => vi.fn());
vi.mock('../../src/internal/abandoned.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/internal/abandoned.ts')>()),
  leaveWorkBehind,
}));

const noop = async () => {};
/** The package root, so a test declared in this file has a project-relative source. */
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ENV = {} as NodeJS.ProcessEnv;
const CHANGES = Object.freeze({ base: 'a'.repeat(40), root: ROOT, files: Object.freeze(['src/app.ts']) });
const SECRET = 'sk-live-0123456789';
const PASSWORD = 'correct-horse-battery';
/** An engine that saves and restores state, so a test may use a session. */
const ENGINE = defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, state: { capture: async () => ({ format: 'toy', version: 1, data: {} }), restore: async () => undefined } });

/** One collected file of `body`'s tests. */
async function collection(body: () => void, file = 'tests/a.e2e.ts'): Promise<Collection> {
  const registration = await collectModule(async () => body());
  const collected = collectFromRegistration(ROOT, `${ROOT}/${file}`, registration, true);
  return { files: [collected], tests: collected.tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
}

/** A config on one web target, with a static secret and a credential password the ledger knows. */
function config(raw: Partial<E2EConfig> = {}): ResolvedConfig {
  return resolveConfig(
    {
      targets: [{ name: 'web', platform: 'web' }],
      secrets: { apiKey: SECRET },
      credentials: { admin: { username: 'admin', password: PASSWORD } },
      ...raw,
    },
    { projectRoot: ROOT, env: ENV },
  );
}

/** A filter named `name` deciding with `decide`. */
function filterOf(name: string, decide: TestFilter['filter']): TestFilter {
  return { name, filter: decide };
}

/** A scope that records its notices and the filter names it wrapped as steps. */
function scope(overrides: Partial<TestFilterScope> = {}) {
  const notices: string[] = [];
  const steps: string[] = [];
  const value: TestFilterScope = {
    projectRoot: ROOT,
    changes: CHANGES,
    configFile: 'e2e.ci.config.ts',
    secrets: config().allSecrets,
    collectedIds: new Set(),
    timeoutMs: FILTER_TIMEOUT_MS,
    signal: new AbortController().signal,
    notice: (message) => notices.push(message),
    step: async (name, work) => {
      steps.push(name);
      return work();
    },
    ...overrides,
  };
  return { scope: value, notices, steps };
}

/** Candidates for plain tests titled `titles`, in order. */
async function candidatesOf(...titles: string[]): Promise<readonly TestFilterCandidate[]> {
  const col = await collection(() => {
    for (const title of titles) test(title, noop);
  });
  return filterCandidates(select(col, config()));
}

/** A candidate's own title: the last of its title path. */
function titleOf(candidate: TestFilterCandidate): string {
  return candidate.titlePath.at(-1)!;
}

/** The id of the candidate titled `title`. */
function idOf(candidates: readonly TestFilterCandidate[], title: string): string {
  const candidate = candidates.find((entry) => titleOf(entry) === title);
  if (candidate === undefined) throw new Error(`no candidate titled ${title}`);
  return candidate.id;
}

/** What `work` rejected with. */
async function rejection(work: Promise<unknown>): Promise<E2EError> {
  try {
    await work;
  } catch (error) {
    return error as E2EError;
  }
  throw new Error('expected a rejection');
}

/** A filter that records the context of each call and never settles, whatever its signal says. */
function hanging(name: string) {
  const seen: TestFilterContext[] = [];
  const filter = filterOf(name, (_tests, context) => {
    seen.push(context);
    return new Promise<TestFilterResult>(() => undefined);
  });
  return { filter, seen };
}

describe('filterSelection', () => {
  /** What `filterSelection` is handed for `col` under `cfg`, judging a ref git cannot measure from, so a lookup would throw; and the notices it wrote. */
  function options(col: Collection, cfg: ResolvedConfig, overrides: Partial<FilterSelectionOptions> = {}) {
    const notices: string[] = [];
    const value: FilterSelectionOptions = {
      config: cfg,
      collection: col,
      selectionFilters: {},
      changedSince: 'no-such-ref',
      signal: new AbortController().signal,
      notice: (message) => notices.push(message),
      ...overrides,
    };
    return { value, notices };
  }

  it('keeps the selection it was handed when the config has no filter, warning unless interrupted, and asks no git', async () => {
    const col = await collection(() => test('a', noop));
    const cfg = config();
    const first = select(col, cfg);
    const { value, notices } = options(col, cfg);
    const kept = await filterSelection(first, value);
    expect(kept).toEqual({ selection: first, records: [], changes: undefined, relevance: new Map() });
    expect(kept.selection).toBe(first);
    expect(notices).toEqual(['warning: --changed-since: the config has no filters, so every test runs']);

    const controller = new AbortController();
    controller.abort();
    const interrupted = options(col, cfg, { signal: controller.signal });
    expect((await filterSelection(first, interrupted.value)).selection).toBe(first);
    expect(interrupted.notices).toEqual([]);
  });

  it('keeps the selection it was handed when the gate calls no filter, recording why', async () => {
    const col = await collection(() => test('a', noop));
    const never = vi.fn(() => ({ exclude: {} }));
    const cfg = config({ filters: [filterOf('areas', never)] });
    const first = select(col, cfg);
    const { value, notices } = options(col, cfg, { selectionFilters: { lastFailed: new Set() } });
    const kept = await filterSelection(first, value);
    expect(kept).toEqual({ selection: first, records: [], changes: { skipped: '--last-failed' }, relevance: new Map() });
    expect(kept.selection).toBe(first);
    expect(notices).toEqual(['--last-failed: the tests the last run owes run without filters']);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('filterCandidates', () => {
  it('hands over each test the selection runs once, in report order, frozen, by id, file, title path, and tags', async () => {
    const col = await collection(() => {
      test.setup('sign in', { sessions: ['member'] }, noop);
      test('signed in', { session: 'member', tags: ['auth'] }, noop);
      test.describe('checkout', { tags: ['billing'] }, () => {
        test('pays', { tags: ['smoke'] }, noop);
      });
      test.skip('later', noop);
      test('on ios only', { platforms: ['ios'] }, noop);
      test('needs a device', { requires: ['device'] }, noop);
      test('slow', { tags: ['slow'] }, noop);
    });
    const cfg = resolveConfig(
      {
        targets: [
          { name: 'web', platform: 'web', engine: ENGINE },
          { name: 'web-2', platform: 'web', engine: ENGINE },
        ],
        agents: { default: {}, admin: {} },
      },
      { projectRoot: ROOT, env: ENV, cli: { agents: ['default', 'admin'] } },
    );
    const candidates = filterCandidates(select(col, cfg, { excludeTags: ['slow'] }));

    // Two targets and two agents, one candidate per test; the setup, the skip, the tests no target runs are never offered.
    expect(candidates.map(titleOf)).toEqual(['signed in', 'pays']);
    const pays = candidates[1]!;
    expect(pays).toEqual({
      id: col.tests.find((entry) => entry.title === 'pays')!.id,
      file: 'tests/a.e2e.ts',
      titlePath: ['checkout', 'pays'],
      tags: ['billing', 'smoke'],
    });
    expect(Object.isFrozen(candidates)).toBe(true);
    for (const candidate of candidates) {
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.titlePath)).toBe(true);
      expect(Object.isFrozen(candidate.tags)).toBe(true);
    }
  });

  it('orders candidates by file, then declaration, whichever target runs them first', async () => {
    const a = await collection(() => {
      test('a ios only', { platforms: ['ios'] }, noop);
      test('a anywhere', noop);
    }, 'tests/a.e2e.ts');
    const b = await collection(() => {
      test('b anywhere', noop);
      test('b ios only', { platforms: ['ios'] }, noop);
    }, 'tests/b.e2e.ts');
    const col: Collection = { ...a, files: [...a.files, ...b.files], tests: [...a.tests, ...b.tests] };
    const cfg = config({ targets: [{ name: 'web', platform: 'web' }, { name: 'ios', platform: 'ios' }] });
    expect(filterCandidates(select(col, cfg)).map((candidate) => candidate.id)).toEqual([
      'tests/a.e2e.ts::a%20ios%20only',
      'tests/a.e2e.ts::a%20anywhere',
      'tests/b.e2e.ts::b%20anywhere',
      'tests/b.e2e.ts::b%20ios%20only',
    ]);
  });

  it('names the file of the setup test that saves each candidate session, and none for a test without one', async () => {
    const setups = await collection(() => {
      test.setup('sign in', { sessions: ['member', 'admin'] }, noop);
    }, 'tests/auth.setup.e2e.ts');
    const pages = await collection(() => {
      test('member page', { session: 'member' }, noop);
      test('admin page', { session: 'admin', tags: ['slow'] }, noop);
      test('guest page', noop);
    }, 'tests/pages.e2e.ts');
    const col: Collection = { ...setups, files: [...setups.files, ...pages.files], tests: [...setups.tests, ...pages.tests] };
    const selection = select(col, config({ targets: [{ name: 'web', platform: 'web', engine: ENGINE }] }), { excludeTags: ['slow'] });
    expect(filterCandidates(selection).map(({ titlePath, setupFile }) => [titlePath.at(-1), setupFile])).toEqual([
      ['member page', 'tests/auth.setup.e2e.ts'],
      ['guest page', undefined],
    ]);
  });
});

describe('applyTestFilters', () => {
  it('calls each filter in order on the tests the ones before it kept, inside its step, and records each decision', async () => {
    const candidates = await candidatesOf('a', 'b', 'c');
    const seen: string[][] = [];
    const first = filterOf('areas', (tests) => {
      seen.push(tests.map(titleOf));
      return { exclude: { [idOf(candidates, 'a')]: 'the diff misses it' } };
    });
    const second = filterOf('jev', async (tests) => {
      seen.push(tests.map(titleOf));
      return { exclude: { [idOf(candidates, 'c')]: 'Jev: 4% likely affected' }, note: 'one call' };
    });
    const { scope: value, steps } = scope();
    const applied = await applyTestFilters([first, second], candidates, value);

    expect(seen).toEqual([['a', 'b', 'c'], ['b', 'c']]);
    expect(steps).toEqual(['areas', 'jev']);
    expect([...applied.excluded]).toEqual([
      [idOf(candidates, 'a'), { filter: 'areas', reason: 'the diff misses it' }],
      [idOf(candidates, 'c'), { filter: 'jev', reason: 'Jev: 4% likely affected' }],
    ]);
    expect(applied.decisions).toEqual([
      { name: 'areas', candidates: 3 },
      { name: 'jev', candidates: 2, note: 'one call' },
    ]);
  });

  it('does not call a filter once the ones before it left nothing, and says so', async () => {
    const candidates = await candidatesOf('a', 'b');
    const all = filterOf('all', (tests) => ({ exclude: Object.fromEntries(tests.map((entry) => [entry.id, 'not needed'])) }));
    const later = vi.fn(() => ({ exclude: {} }));
    const { scope: value, notices, steps } = scope();
    const applied = await applyTestFilters([all, filterOf('later', later)], candidates, value);
    expect(later).not.toHaveBeenCalled();
    expect(steps).toEqual(['all']);
    expect(notices).toEqual(['later: no tests left to judge']);
    expect(applied.decisions.map((decision) => decision.name)).toEqual(['all']);
    expect(applied.excluded.size).toBe(2);
  });

  it('hands a filter a frozen list and a context of the project root, the change, the loaded config, the signal, log, and redact', async () => {
    const candidates = await candidatesOf('a');
    const controller = new AbortController();
    let received: { tests: readonly TestFilterCandidate[]; context: TestFilterContext } | undefined;
    const { scope: value } = scope({ signal: controller.signal });
    await applyTestFilters(
      [
        filterOf('areas', (tests, context) => {
          received = { tests, context };
          return { exclude: {} };
        }),
      ],
      candidates,
      value,
    );
    expect(received!.tests).toEqual(candidates);
    expect(Object.isFrozen(received!.tests)).toBe(true);
    expect(Object.keys(received!.context).toSorted()).toEqual(['changes', 'configFile', 'log', 'projectRoot', 'redact', 'signal']);
    expect(received!.context.projectRoot).toBe(ROOT);
    expect(received!.context.changes).toBe(CHANGES);
    expect(received!.context.configFile).toBe('e2e.ci.config.ts');
    expect(Object.isFrozen(received!.context)).toBe(true);
    // The signal is the run's interrupt combined with the filter's deadline.
    expect(received!.context.signal.aborted).toBe(false);
    controller.abort();
    expect(received!.context.signal.aborted).toBe(true);
  });

  it('accepts a synchronous answer, an exclude without a prototype, and drops an empty note', async () => {
    const candidates = await candidatesOf('a', 'b');
    const exclude = Object.assign(Object.create(null) as Record<string, string>, { [idOf(candidates, 'b')]: '  trimmed  ' });
    const { scope: value } = scope();
    const applied = await applyTestFilters([filterOf('areas', () => ({ exclude, note: '   ' }))], candidates, value);
    expect([...applied.excluded]).toEqual([[idOf(candidates, 'b'), { filter: 'areas', reason: 'trimmed' }]]);
    expect(applied.decisions[0]).toEqual({ name: 'areas', candidates: 2 });
    expect(applied.decisions[0]).not.toHaveProperty('note');
  });

  it('redacts every static secret and credential password in reasons, notes, log lines, and what redact returns', async () => {
    const candidates = await candidatesOf('a', 'b');
    let redacted = '';
    const { scope: value, notices } = scope();
    const applied = await applyTestFilters(
      [
        filterOf('areas', (_tests, { log, redact }) => {
          log(`diffing with key ${SECRET}`);
          redacted = redact(`password ${PASSWORD}`);
          return { exclude: { [idOf(candidates, 'a')]: `the key ${SECRET} says so` }, note: `signed in with ${PASSWORD}` };
        }),
      ],
      candidates,
      value,
    );
    const written = JSON.stringify({ applied: [...applied.excluded], decisions: applied.decisions, notices, redacted });
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(PASSWORD);
    expect(notices).toEqual([expect.stringMatching(/^areas: diffing with key <secret:[^>]+>$/)]);
    expect(redacted).toMatch(/^password <secret:[^>]+>$/);
    expect(applied.excluded.get(idOf(candidates, 'a'))!.reason).toMatch(/^the key <secret:[^>]+> says so$/);
    expect(applied.decisions[0]!.note).toMatch(/^signed in with <secret:[^>]+>$/);
  });

  it('hands a filter a redact that also masks every run of 8 or more characters of a value, so no part of a key survives a diff that shows its lines only in part', async () => {
    const keyLines = Array.from({ length: 12 }, (_, line) => createHash('sha512').update(String(line)).digest('base64').slice(0, 64));
    const pem = ['-----BEGIN PRIVATE KEY-----', ...keyLines, '-----END PRIVATE KEY-----'].join('\n');
    const diff = [
      `@@ -13,4 +13,4 @@ ${keyLines[0]!.slice(0, 30)}`,
      ...pem.split('\n').map((line, index) => `${' +-'[index % 3]}${index % 2 === 0 ? line.slice(3) : line.slice(0, -3)}`),
    ].join('\n');
    let redacted = '';
    const { scope: value } = scope({ secrets: config({ secrets: { pem } }).allSecrets });
    await applyTestFilters(
      [
        filterOf('jev', (_tests, { redact }) => {
          redacted = redact(diff);
          return { exclude: {} };
        }),
      ],
      await candidatesOf('a'),
      value,
    );
    const runs = pem.split('\n').flatMap((line) => Array.from({ length: line.length - 7 }, (_, start) => line.slice(start, start + 8)));
    expect(runs.filter((run) => redacted.includes(run))).toEqual([]);
    expect(redacted.split('\n')[0]).toBe('@@ -13,4 +13,4 @@ <secret:pem>');
  });

  it('keeps a reason, a note, and a log line on one line, cut to 1024 code points, never through an emoji', async () => {
    const candidates = await candidatesOf('a', 'b');
    const long = `Gateway failed:\n\n  no key\n\t${'😀'.repeat(2000)}`;
    const { scope: value, notices } = scope();
    const applied = await applyTestFilters(
      [
        filterOf('areas', (_tests, { log }) => {
          log(long);
          return { exclude: { [idOf(candidates, 'a')]: long }, note: long };
        }),
      ],
      candidates,
      value,
    );
    const cut = `Gateway failed: no key ${'😀'.repeat(1000)}…`;
    expect(applied.excluded.get(idOf(candidates, 'a'))!.reason).toBe(cut);
    expect(applied.decisions[0]!.note).toBe(cut);
    expect(notices).toEqual([`areas: ${cut}`]);
    expect([...applied.decisions[0]!.note!]).toHaveLength(1024);
    // At the bound, nothing is cut.
    const exact = 'x'.repeat(1024);
    const kept = await applyTestFilters([filterOf('areas', () => ({ exclude: { [idOf(candidates, 'b')]: exact } }))], candidates, scope().scope);
    expect(kept.excluded.get(idOf(candidates, 'b'))!.reason).toBe(exact);
  });

  it('drops a log line a filter writes after its call returned or threw', async () => {
    const candidates = await candidatesOf('a');
    const logs: TestFilterContext['log'][] = [];
    const { scope: value, notices } = scope();
    const returned = filterOf('areas', (_tests, { log }) => {
      logs.push(log);
      return { exclude: {} };
    });
    await applyTestFilters([returned], candidates, value);
    const threw = filterOf('jev', (_tests, { log }) => {
      logs.push(log);
      throw new Error('no diff');
    });
    await applyTestFilters([threw], candidates, value);
    for (const log of logs) log('too late');
    expect(logs).toHaveLength(2);
    expect(notices).toEqual(['warning: jev failed, so it leaves nothing out: no diff']);
  });

  it('leaves nothing out when a filter throws a value that cannot be shown as text', async () => {
    const candidates = await candidatesOf('a');
    const { scope: value, notices } = scope();
    const applied = await applyTestFilters([filterOf('odd', () => Promise.reject(Object.create(null)))], candidates, value);
    expect(applied.excluded.size).toBe(0);
    expect(notices).toEqual(['warning: odd failed, so it leaves nothing out: a value that cannot be shown as text']);
  });

  it('ignores an id it was not given whose test is collected, since that test\'s fate is settled: a setup test, a test another flag left out, and one an earlier filter left out, which keeps that filter\'s reason', async () => {
    const candidates = await candidatesOf('a', 'b');
    const b = idOf(candidates, 'b');
    const setup = 'tests/auth.setup.e2e.ts::sign%20in';
    const sharded = 'tests/z.e2e.ts::outside%20the%20shard';
    const { scope: value } = scope({ collectedIds: new Set([...candidates.map((candidate) => candidate.id), setup, sharded]) });
    const filters = [filterOf('areas', () => ({ exclude: { [setup]: 'not needed', [b]: 'unaffected', [sharded]: 'unaffected' } })), filterOf('jev', () => ({ exclude: { [b]: 'again' } }))];
    const applied = await applyTestFilters(filters, candidates, value);
    expect([...applied.excluded]).toEqual([[b, { filter: 'areas', reason: 'unaffected' }]]);
    expect(applied.decisions).toEqual([
      { name: 'areas', candidates: 2 },
      { name: 'jev', candidates: 1 },
    ]);
  });

  describe('scores', () => {
    it('collects the score each filter gives a test, keeps the highest across filters, and drops a collected test it was not handed', async () => {
      const candidates = await candidatesOf('a', 'b', 'c');
      const [a, b, c] = ['a', 'b', 'c'].map((title) => idOf(candidates, title)) as [string, string, string];
      const outside = 'tests/z.e2e.ts::outside%20the%20shard';
      const { scope: value } = scope({ collectedIds: new Set([...candidates.map((candidate) => candidate.id), outside]) });
      const applied = await applyTestFilters(
        [
          filterOf('areas', () => ({ exclude: { [c]: 'unaffected' }, relevance: { [a]: 0.9, [b]: 0.3, [outside]: 1 } })),
          filterOf('jev', () => ({ exclude: {}, relevance: { [a]: 0.4, [b]: 0.6, [c]: 1 } })),
        ],
        candidates,
        value,
      );
      // `jev` was never handed `c`, which `areas` left out, and `areas` never `outside`.
      expect([...applied.relevance]).toEqual([
        [a, 0.9],
        [b, 0.6],
      ]);
      expect(applied.decisions).toEqual([
        { name: 'areas', candidates: 3 },
        { name: 'jev', candidates: 2 },
      ]);
    });

    it('takes 0 and 1, a relevance without a prototype, and no relevance at all, which scores nothing', async () => {
      const candidates = await candidatesOf('a', 'b');
      const relevance = Object.assign(Object.create(null) as Record<string, number>, { [idOf(candidates, 'a')]: 0, [idOf(candidates, 'b')]: 1 });
      const { scope: value } = scope();
      const scored = await applyTestFilters([filterOf('areas', () => ({ exclude: {}, relevance }))], candidates, value);
      expect([...scored.relevance]).toEqual([
        [idOf(candidates, 'a'), 0],
        [idOf(candidates, 'b'), 1],
      ]);
      const silent = await applyTestFilters([filterOf('areas', () => ({ exclude: {} }))], candidates, value);
      expect(silent.relevance.size).toBe(0);
      expect((await applyTestFilters([filterOf('areas', () => ({ exclude: {}, relevance: {} }))], candidates, value)).relevance.size).toBe(0);
    });

    it('scores nothing for a filter that throws without scores or is refused, even when its scores were valid', async () => {
      const candidates = await candidatesOf('a', 'b');
      const a = idOf(candidates, 'a');
      const { scope: value } = scope();
      const applied = await applyTestFilters(
        [
          filterOf('refused', () => invalid<TestFilterResult>({ exclude: { nope: 'x' }, relevance: { [a]: 1 } })),
          filterOf('threw', () => {
            throw new Error('no diff');
          }),
          filterOf('thrown text', () => Promise.reject('no key')),
        ],
        candidates,
        value,
      );
      expect(applied.relevance.size).toBe(0);
    });

    describe('of a filter that fails', () => {
      /** The error a filter throws when it cannot finish but still knows how likely some tests are to fail. */
      const failing = (message: string, relevance: unknown): Error => Object.assign(new Error(message), { relevance });

      it('scores the tests its error names, keeping the highest across filters, and still warns and records the failure', async () => {
        const candidates = await candidatesOf('a', 'b', 'c');
        const [a, b, c] = ['a', 'b', 'c'].map((title) => idOf(candidates, title)) as [string, string, string];
        const outside = 'tests/z.e2e.ts::outside%20the%20shard';
        const { scope: value, notices } = scope({ collectedIds: new Set([...candidates.map((candidate) => candidate.id), outside]) });
        const applied = await applyTestFilters(
          [
            filterOf('answers', () => ({ exclude: {}, relevance: { [c]: 0.9 } })),
            filterOf('throws', () => {
              throw failing('no key', { [a]: 1, [b]: 0.5, [outside]: 1 });
            }),
            filterOf('rejects', () => Promise.reject(failing('offline', { [b]: 0.7, [c]: 0.2 }))),
          ],
          candidates,
          value,
        );
        // `outside` is collected but was never handed over, so its score is dropped as a result's is.
        expect([...applied.relevance]).toEqual([
          [c, 0.9],
          [a, 1],
          [b, 0.7],
        ]);
        expect(applied.excluded.size).toBe(0);
        expect(applied.decisions).toEqual([
          { name: 'answers', candidates: 3 },
          { name: 'throws', candidates: 3, note: 'failed, so it leaves nothing out: no key', outcome: 'failed' },
          { name: 'rejects', candidates: 3, note: 'failed, so it leaves nothing out: offline', outcome: 'failed' },
        ]);
        expect(notices).toEqual(['warning: throws failed, so it leaves nothing out: no key', 'warning: rejects failed, so it leaves nothing out: offline']);
      });

      it.each<[string, (id: string) => unknown, (id: string) => string]>([
        ['a score above 1', (id) => ({ [id]: 2 }), (id) => `the relevance of "${id}" must be a number from 0 to 1, got 2`],
        ['a score of NaN', (id) => ({ [id]: Number.NaN }), (id) => `the relevance of "${id}" must be a number from 0 to 1, got NaN`],
        ['an id no collected test has', () => ({ nope: 1 }), () => 'relevance names "nope", which no collected test has; relevance takes test.id'],
        ['a list', () => [], () => 'relevance must be a plain object of test ids to numbers from 0 to 1, got an array'],
        ['a number', () => 1, () => 'relevance must be a plain object of test ids to numbers from 0 to 1, got 1'],
      ])('drops %s and says so in the note, before the failure it follows', async (_label, relevance, issue) => {
        const candidates = await candidatesOf('a', 'b');
        const a = idOf(candidates, 'a');
        const { scope: value, notices } = scope();
        const applied = await applyTestFilters(
          [
            filterOf('areas', () => {
              throw failing('no key', relevance(a));
            }),
          ],
          candidates,
          value,
        );
        const note = `failed, ignoring its relevance (${issue(a)}), so it leaves nothing out: no key`;
        expect(applied.relevance.size).toBe(0);
        expect(applied.decisions).toEqual([{ name: 'areas', candidates: 2, note, outcome: 'failed' }]);
        expect(notices).toEqual([`warning: areas ${note}`]);
      });

      it('drops a relevance that cannot be read, such as a getter that throws, and says so', async () => {
        const candidates = await candidatesOf('a');
        const unreadable = Object.defineProperty(new Error('no key'), 'relevance', {
          get() {
            throw new Error('getter broke');
          },
        });
        const { scope: value } = scope();
        const applied = await applyTestFilters(
          [
            filterOf('areas', () => {
              throw unreadable;
            }),
          ],
          candidates,
          value,
        );
        expect(applied.relevance.size).toBe(0);
        expect(applied.decisions).toEqual([{ name: 'areas', candidates: 1, note: 'failed, ignoring its relevance (getter broke), so it leaves nothing out: no key', outcome: 'failed' }]);
      });

      it('redacts a secret in why the scores were dropped, whether a score quotes it or the error that stopped the read does', async () => {
        const candidates = await candidatesOf('a');
        const a = idOf(candidates, 'a');
        const hostile = Object.defineProperty(new Error('no key'), 'relevance', {
          get() {
            throw new Error(`reading it failed with ${SECRET}`);
          },
        });
        const { scope: value } = scope();
        const applied = await applyTestFilters(
          [
            filterOf('quotes', () => {
              throw failing('no key', { [a]: SECRET });
            }),
            filterOf('reads', () => {
              throw hostile;
            }),
          ],
          candidates,
          value,
        );
        const [quotes, reads] = applied.decisions.map((decision) => decision.note ?? '') as [string, string];
        expect(quotes).toMatch(/got "<secret:[^>]+>"\), so it leaves nothing out: no key$/u);
        expect(reads).toMatch(/ignoring its relevance \(reading it failed with <secret:[^>]+>\), so it leaves nothing out: no key$/u);
        for (const note of [quotes, reads]) expect(note).not.toContain(SECRET);
      });

      it('keeps the failure in the note when the reason the scores were dropped is long, and cuts a long failure after that reason, to one line of 1024 code points', async () => {
        const candidates = await candidatesOf('a');
        const a = idOf(candidates, 'a');
        const long = 'x'.repeat(5000);
        const { scope: value } = scope();
        const applied = await applyTestFilters(
          [
            filterOf('quiet', () => {
              throw failing('no key', { [a]: long });
            }),
            filterOf('verbose', () => {
              throw failing(long, { nope: 1 });
            }),
          ],
          candidates,
          value,
        );
        const [quiet, verbose] = applied.decisions.map((decision) => decision.note ?? '') as [string, string];
        // The reason is cut to 300 code points, and the failure's message still follows it.
        const reason = /^failed, ignoring its relevance \((.*)\), so it leaves nothing out: no key$/u.exec(quiet)?.[1] ?? '';
        expect(reason).toMatch(/^the relevance of ".*…$/u);
        expect([...reason]).toHaveLength(300);
        // A long message is what the cut shortens, and the reason before it survives.
        expect(verbose).toMatch(/^failed, ignoring its relevance \(relevance names "nope", which no collected test has; relevance takes test\.id\), so it leaves nothing out: x+…$/u);
        expect([...verbose]).toHaveLength(1024);
      });

      it('scores nothing for a filter that outran its deadline, even when it then rejects with scores: the call was abandoned, and what it throws after is not read', async () => {
        const candidates = await candidatesOf('a');
        const obedient = filterOf(
          'jev',
          (_tests, { signal }) =>
            new Promise<TestFilterResult>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(Object.assign(signal.reason as Error, { relevance: { [idOf(candidates, 'a')]: 1 } })), { once: true });
            }),
        );
        const { scope: value } = scope({ timeoutMs: 20 });
        const applied = await applyTestFilters([obedient], candidates, value);
        expect(applied.relevance.size).toBe(0);
        expect(applied.decisions).toEqual([{ name: 'jev', candidates: 1, note: 'did not finish within 20ms, so it leaves nothing out', outcome: 'timed-out' }]);
      });
    });
  });

  describe('refuses a result that is not { exclude, relevance?, note? }, warning and leaving nothing out', () => {
    /** The note the `areas` filter leaves when it answers `answer` over tests signs in, pays, and refunds, checking it failed open: one warning, a failed decision, nothing left out. */
    async function refusal(answer: (candidates: readonly TestFilterCandidate[]) => unknown, overrides: Partial<TestFilterScope> = {}): Promise<string> {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const filter = filterOf('areas', () => invalid<TestFilterResult>(answer(candidates)));
      const { scope: value, notices } = scope(overrides);
      const applied = await applyTestFilters([filter], candidates, value);
      const note = applied.decisions[0]?.note ?? '';
      expect(applied.decisions).toEqual([{ name: 'areas', candidates: 3, note, outcome: 'failed' }]);
      expect(applied.excluded.size).toBe(0);
      expect(applied.relevance.size).toBe(0);
      expect(notices).toEqual([`warning: areas ${note}`]);
      return note;
    }
    const PREFIX = 'returned an invalid result, so it leaves nothing out: ';
    /** The refusal of any key but exclude, relevance, and note. */
    const UNKNOWN = ": a filter returns { exclude: { [test.id]: reason }, relevance?: { [test.id]: 0 to 1 }, note? }, and every test it doesn't name runs";
    /** The refusal of an id no collected test has. */
    const STRANGER = ', which no collected test has; exclude takes test.id';
    /** The refusal of a score for an id no collected test has. */
    const UNSCORED = ', which no collected test has; relevance takes test.id';

    it.each([
      ['null', () => null, 'expected { exclude, relevance?, note? }, got null'],
      ['undefined', () => undefined, 'expected { exclude, relevance?, note? }, got undefined'],
      ['an array', () => [], 'expected { exclude, relevance?, note? }, got an array'],
      ['a string', () => 'all', 'expected { exclude, relevance?, note? }, got "all"'],
      ['a keep list', () => ({ keep: [] }), `unknown key "keep"${UNKNOWN}`],
      ['an include map, never pointed at exclude', () => ({ include: {} }), `unknown key "include"${UNKNOWN}`],
      ['two unknown keys, naming the first', () => ({ exclude: {}, why: '', because: '' }), `unknown key "why"${UNKNOWN}`],
      ['no exclude', () => ({ note: 'nothing' }), 'exclude must be a plain object of test ids to reasons, got undefined'],
      ['an exclude map', () => ({ exclude: new Map() }), 'exclude must be a plain object of test ids to reasons, got an object'],
      ['a numeric note', () => ({ exclude: {}, note: 3 }), 'note must be a string, got 3'],
      ['a relevance of null', () => ({ exclude: {}, relevance: null }), 'relevance must be a plain object of test ids to numbers from 0 to 1, got null'],
      ['a relevance list', () => ({ exclude: {}, relevance: [] }), 'relevance must be a plain object of test ids to numbers from 0 to 1, got an array'],
      ['a relevance map', () => ({ exclude: {}, relevance: new Map() }), 'relevance must be a plain object of test ids to numbers from 0 to 1, got an object'],
      ['a relevance number', () => ({ exclude: {}, relevance: 1 }), 'relevance must be a plain object of test ids to numbers from 0 to 1, got 1'],
    ])('%s', async (_label, answer, issue) => {
      expect(await refusal(answer)).toBe(`${PREFIX}${issue}`);
    });

    it('inside the filter\'s step, which then ends failed, as it does for a throw', async () => {
      const candidates = await candidatesOf('a');
      const ended: string[] = [];
      const { scope: value } = scope({
        step: async (name, work) => {
          const call = await work();
          ended.push(`${name}: ${call.outcome}`);
          return call;
        },
      });
      const refused = filterOf('areas', () => invalid<TestFilterResult>({ exclude: { nope: 'x' } }));
      const threw = filterOf('jev', () => {
        throw new Error('no diff');
      });
      await applyTestFilters([refused, threw, filterOf('quick', () => ({ exclude: {} }))], candidates, value);
      expect(ended).toEqual(['areas: failed', 'jev: failed', 'quick: answered']);
    });

    it('a reason that is not a non-empty string, naming the first test', async () => {
      for (const reason of ['', '   ', 42, null]) {
        const note = await refusal((candidates) => ({ exclude: { [idOf(candidates, 'pays')]: reason } }));
        expect(note).toMatch(new RegExp(`^${PREFIX}the reason for ".+::pays" must be a non-empty string, got `));
      }
      const two = await refusal((candidates) => ({ exclude: { [idOf(candidates, 'pays')]: '', [idOf(candidates, 'refunds')]: 7 } }));
      expect(two).toContain('::pays" must be a non-empty string, got ""');
    });

    it('an id no collected test has, a title or a mistyped id among them, saying exclude takes test.id', async () => {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const id = idOf(candidates, 'pays');
      const typo = await refusal(() => ({ exclude: { [`${id}x`]: 'nope' } }), { collectedIds: new Set(candidates.map((candidate) => candidate.id)) });
      expect(typo).toBe(`${PREFIX}exclude names ${JSON.stringify(`${id}x`)}${STRANGER}`);
      const title = await refusal(() => ({ exclude: { pays: 'unaffected' } }));
      expect(title).toBe(`${PREFIX}exclude names "pays"${STRANGER}`);
      const several = await refusal(() => ({ exclude: { 'tests/zz.e2e.ts::nothing': 'a', 'tests/zz.e2e.ts::else': 'b' } }));
      expect(several).toBe(`${PREFIX}exclude names "tests/zz.e2e.ts::nothing"${STRANGER}`);
    });

    it('a score that is not a number from 0 to 1, naming the first test and what it was', async () => {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const pays = idOf(candidates, 'pays');
      const rows: [unknown, string][] = [
        [-0.01, '-0.01'],
        [1.01, '1.01'],
        [Number.NaN, 'NaN'],
        [Number.POSITIVE_INFINITY, 'Infinity'],
        [Number.NEGATIVE_INFINITY, '-Infinity'],
        ['0.5', '"0.5"'],
        ['', '""'],
        [null, 'null'],
        [undefined, 'undefined'],
        [true, 'true'],
        [[0.5], 'an array'],
      ];
      for (const [score, got] of rows) {
        const note = await refusal(() => ({ exclude: {}, relevance: { [pays]: score } }));
        expect(note).toBe(`${PREFIX}the relevance of ${JSON.stringify(pays)} must be a number from 0 to 1, got ${got}`);
      }
      const two = await refusal(() => ({ exclude: {}, relevance: { [idOf(candidates, 'signs in')]: 0.5, [pays]: 2, [idOf(candidates, 'refunds')]: 'high' } }));
      expect(two).toBe(`${PREFIX}the relevance of ${JSON.stringify(pays)} must be a number from 0 to 1, got 2`);
    });

    it('a score for an id no collected test has, a title among them, saying relevance takes test.id', async () => {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const id = idOf(candidates, 'pays');
      const typo = await refusal(() => ({ exclude: {}, relevance: { [`${id}x`]: 1 } }), { collectedIds: new Set(candidates.map((candidate) => candidate.id)) });
      expect(typo).toBe(`${PREFIX}relevance names ${JSON.stringify(`${id}x`)}${UNSCORED}`);
      const title = await refusal(() => ({ exclude: {}, relevance: { pays: 1 } }));
      expect(title).toBe(`${PREFIX}relevance names "pays"${UNSCORED}`);
    });

    it('redacts and cuts what it echoes, like a reason: a secret as an id or a key, quoting at most 200 code points of either, or the whole answer', async () => {
      /** How `note` quotes the key or id it echoes: its secret marker, then emoji up to 200 code points, the last an ellipsis. */
      const capped = (note: string) => {
        const marker = /<secret:[^>]+>/u.exec(note)?.[0] ?? '<no secret marker>';
        return `"${marker}${'😀'.repeat(199 - [...marker].length)}…"`;
      };
      const long = '😀'.repeat(20_000);
      const id = await refusal(() => ({ exclude: { [`${SECRET}${long}`]: 'r' } }));
      expect(id).toBe(`${PREFIX}exclude names ${capped(id)}${STRANGER}`);
      const key = await refusal(() => ({ exclude: {}, [`${PASSWORD}${long}`]: 'r' }));
      expect(key).toBe(`${PREFIX}unknown key ${capped(key)}${UNKNOWN}`);
      const score = await refusal(() => ({ exclude: {}, relevance: { [`${SECRET}${long}`]: 1 } }));
      expect(score).toBe(`${PREFIX}relevance names ${capped(score)}${UNSCORED}`);
      const answer = await refusal(() => `${SECRET}\n${'x'.repeat(5000)}`);
      expect(answer).toMatch(new RegExp(`^${PREFIX}expected \\{ exclude, relevance\\?, note\\? \\}, got "<secret:[^>]+>\\\\nx+…$`));
      expect([...answer]).toHaveLength(1024);
      for (const note of [id, key, score, answer]) expect(note).not.toContain(SECRET);
    });

    it('a result that throws as it is read, redacted', async () => {
      const configuration = await refusal(() => ({
        get exclude(): never {
          throw new ConfigurationError('INVALID_CONFIG', `bad token ${SECRET}`);
        },
      }));
      expect(configuration).toMatch(new RegExp(`^${PREFIX}bad token <secret:[^>]+>$`));
    });
  });

  describe('leaves nothing out when a filter throws, warning and recording a redacted one-line note of at most 1024 code points with what it threw last, and calls the next filter on every test it was given', () => {
    const THROWN = `git diff failed with ${SECRET}\n${'x'.repeat(2000)}`;

    it.each<[string, TestFilter['filter']]>([
      ['a plain error', () => Promise.reject(new Error(THROWN))],
      [
        'a TypeError, thrown synchronously',
        () => {
          throw new TypeError(THROWN);
        },
      ],
      ['a model answer the agent could not use, never a test failure', () => Promise.reject(new AgentError('MODEL_OUTPUT_INVALID', THROWN))],
      ['a configuration error, like any other', () => Promise.reject(new ConfigurationError('MODEL_UNAVAILABLE', THROWN))],
    ])('%s', async (_label, decide) => {
      const candidates = await candidatesOf('a', 'b');
      const later = vi.fn(() => ({ exclude: {} }));
      const { scope: value, notices } = scope();
      leaveWorkBehind.mockClear();
      const applied = await applyTestFilters([filterOf('areas', decide), filterOf('later', later)], candidates, value);
      const note = applied.decisions[0]?.note ?? '';
      expect(note).toMatch(/^failed, so it leaves nothing out: git diff failed with <secret:[^>]+> x+…$/u);
      expect([...note]).toHaveLength(1024);
      expect(notices).toEqual([`warning: areas ${note}`]);
      expect(applied.decisions).toEqual([
        { name: 'areas', candidates: 2, note, outcome: 'failed' },
        { name: 'later', candidates: 2 },
      ]);
      expect(later).toHaveBeenCalledWith(candidates, expect.anything());
      expect(applied.excluded.size).toBe(0);
      expect(leaveWorkBehind).not.toHaveBeenCalled();
    });
  });

  it('abandons a filter that ignores its signal when the run is interrupted, as INTERRUPTED with no warning, drops what it logs after, and records the call as work left behind, so the CLI exits once a watch session that cancelled it quits', async () => {
    const candidates = await candidatesOf('a');
    const controller = new AbortController();
    const slow = hanging('slow');
    const { scope: value, notices } = scope({ signal: controller.signal });
    leaveWorkBehind.mockClear();
    const pending = rejection(applyTestFilters([slow.filter], candidates, value));
    await vi.waitFor(() => expect(slow.seen).toHaveLength(1));
    const { log, signal } = slow.seen[0]!;
    log('asking about a');
    expect(leaveWorkBehind).not.toHaveBeenCalled();
    controller.abort();
    expect(await pending).toMatchObject({ code: 'INTERRUPTED', category: 'interrupted', message: 'interrupted while filter "slow" ran' });
    expect(signal.reason).not.toMatchObject({ name: 'TimeoutError' });
    expect(leaveWorkBehind).toHaveBeenCalledTimes(1);
    log('still asking about a');
    expect(notices).toEqual(['slow: asking about a']);

    // No call began, so none was left behind.
    leaveWorkBehind.mockClear();
    const never = vi.fn(() => ({ exclude: {} }));
    const error = await rejection(applyTestFilters([filterOf('areas', never)], candidates, scope({ signal: controller.signal }).scope));
    expect(error).toMatchObject({ code: 'INTERRUPTED', message: 'interrupted while filter "areas" ran' });
    expect(never).not.toHaveBeenCalled();
    expect(leaveWorkBehind).not.toHaveBeenCalled();
  });
});

describe('a filter past the deadline', () => {
  it('is abandoned at its deadline with a TimeoutError on its signal, leaves nothing out, and the next filter judges every test', async () => {
    const candidates = await candidatesOf('a', 'b');
    const slow = hanging('slow');
    const later = vi.fn((tests: readonly TestFilterCandidate[]) => ({ exclude: { [tests[0]!.id]: 'unaffected' } }));
    const ended: string[] = [];
    const { scope: value, notices, steps } = scope({
      timeoutMs: 50,
      step: async (name, work) => {
        steps.push(name);
        const call = await work();
        ended.push(`${name}: ${call.outcome}`);
        return call;
      },
    });
    vi.useFakeTimers();
    try {
      const pending = applyTestFilters([slow.filter, filterOf('later', later)], candidates, value);
      await vi.advanceTimersByTimeAsync(49);
      expect(later).not.toHaveBeenCalled();
      expect(slow.seen[0]!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const applied = await pending;
      expect(slow.seen[0]!.signal.aborted).toBe(true);
      expect(slow.seen[0]!.signal.reason).toMatchObject({ name: 'TimeoutError', message: 'filter "slow" did not finish within 50ms' });
      expect(later).toHaveBeenCalledWith(candidates, expect.anything());
      expect(steps).toEqual(['slow', 'later']);
      expect(ended).toEqual(['slow: timed-out', 'later: answered']);
      expect(notices).toEqual(['warning: slow did not finish within 50ms, so it leaves nothing out']);
      expect(applied.decisions[0]).toEqual({ name: 'slow', candidates: 2, note: 'did not finish within 50ms, so it leaves nothing out', outcome: 'timed-out' });
      expect([...applied.excluded.keys()]).toEqual([idOf(candidates, 'a')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a filter that rejects with its own deadline as timed out, never failed', async () => {
    const candidates = await candidatesOf('a');
    const obedient = filterOf(
      'jev',
      (_tests, { signal }) =>
        new Promise<TestFilterResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    );
    const { scope: value, notices } = scope({ timeoutMs: 20 });
    const applied = await applyTestFilters([obedient], candidates, value);
    expect(applied.decisions).toEqual([{ name: 'jev', candidates: 1, note: 'did not finish within 20ms, so it leaves nothing out', outcome: 'timed-out' }]);
    expect(notices).toEqual(['warning: jev did not finish within 20ms, so it leaves nothing out']);
  });

  it('warns and records the work it left behind at once, before the next filter is called, and leaves none behind for a filter that answers or fails', async () => {
    const candidates = await candidatesOf('a', 'b');
    leaveWorkBehind.mockClear();
    await applyTestFilters([filterOf('quick', () => ({ exclude: {} }))], candidates, scope().scope);
    expect(leaveWorkBehind).not.toHaveBeenCalled();

    const { scope: value, notices } = scope({ timeoutMs: 10 });
    let called: { leftBehind: number; notices: string[] } | undefined;
    const refused = filterOf('refused', () => {
      called = { leftBehind: leaveWorkBehind.mock.calls.length, notices: [...notices] };
      return invalid<TestFilterResult>({ exclude: [] });
    });
    await applyTestFilters([hanging('slow').filter, refused], candidates, value);
    const warning = 'warning: slow did not finish within 10ms, so it leaves nothing out';
    expect(called).toEqual({ leftBehind: 1, notices: [warning] });
    expect(notices).toEqual([warning, 'warning: refused returned an invalid result, so it leaves nothing out: exclude must be a plain object of test ids to reasons, got an array']);
    expect(leaveWorkBehind).toHaveBeenCalledTimes(1);
  });
});

describe('rankingNotice', () => {
  it('says how many of the tests the selection runs were scored, counting each test once across targets, when the scores tell them apart', async () => {
    const col = await collection(() => {
      test('a', noop);
      test('b', noop);
      test('c', { tags: ['slow'] }, noop);
      test.skip('d', noop);
    });
    const cfg = config({ targets: [{ name: 'web', platform: 'web' }, { name: 'web-2', platform: 'web' }] });
    const selection = select(col, cfg, { excludeTags: ['slow'] });
    const candidates = filterCandidates(selection);
    const [a, b] = [idOf(candidates, 'a'), idOf(candidates, 'b')] as [string, string];
    expect(candidates.map(titleOf)).toEqual(['a', 'b']);

    expect(rankingNotice(selection, new Map([[a, 1]]))).toBe('ranked 1 of 2 tests by relevance, likeliest first');
    expect(rankingNotice(selection, new Map([[a, 0.8], [b, 0.1]]))).toBe('ranked 2 of 2 tests by relevance, likeliest first');
    expect(rankingNotice(selection, new Map())).toBeUndefined();
    // A score for a test the selection does not run counts for nothing: a slow test, a skip, a test no file has.
    const slow = col.tests.find((entry) => entry.title === 'c')!.id;
    const skipped = col.tests.find((entry) => entry.title === 'd')!.id;
    expect(rankingNotice(selection, new Map([[slow, 1], [skipped, 1], ['tests/z.e2e.ts::gone', 1]]))).toBeUndefined();
  });

  it('says nothing when the scores leave every test in one band, since the order is the one without them', async () => {
    const col = await collection(() => {
      test('a', noop);
      test('b', noop);
    });
    const selection = select(col, config());
    const [a, b] = [idOf(filterCandidates(selection), 'a'), idOf(filterCandidates(selection), 'b')] as [string, string];
    // 0.8 and 0.9 are both in the top band, and so are 0 and 0.24 in the lowest.
    expect(rankingNotice(selection, new Map([[a, 0.8], [b, 0.9]]))).toBeUndefined();
    expect(rankingNotice(selection, new Map([[a, 0], [b, 0.24]]))).toBeUndefined();
    // One test scored 0.5 beside one unscored is two bands.
    expect(rankingNotice(selection, new Map([[a, 0.5]]))).toBe('ranked 1 of 2 tests by relevance, likeliest first');
    // A single test has nothing to rank against.
    const alone = select(await collection(() => test('only', noop)), config());
    expect(rankingNotice(alone, new Map([[idOf(filterCandidates(alone), 'only'), 1]]))).toBeUndefined();
  });
});

describe('filterRecords and filterSummary', () => {
  /** The records and summary lines of `filters` over a suite with a serial group, selected again with what they left out. */
  async function decided(filters: readonly TestFilter[]) {
    const col = await collection(() => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
      test('pays', noop);
      test('refunds', noop);
    });
    const cfg = config({ targets: [{ name: 'web', platform: 'web' }, { name: 'web-2', platform: 'web' }] });
    const applied = await applyTestFilters(filters, filterCandidates(select(col, cfg)), scope().scope);
    const records = filterRecords(applied.decisions, select(col, cfg, { excluded: applied.excluded }, { passWithNoTests: true }));
    return { records, summaries: records.map((record) => filterSummary(record)) };
  }
  /** Excludes the tests titled `titles`, with one reason. */
  const leaving = (name: string, titles: readonly string[], note?: string): TestFilter =>
    filterOf(name, (tests) => ({
      exclude: Object.fromEntries(tests.filter((entry) => titles.includes(titleOf(entry))).map((entry) => [entry.id, 'unaffected'])),
      ...(note === undefined ? {} : { note }),
    }));

  it('counts distinct tests the final selection leaves out, once across targets, after the serial group took its member back, each filter on its own input, with no summary for one that failed or timed out', async () => {
    const boom = filterOf('boom', () => {
      throw new Error('kaboom');
    });
    const { records, summaries } = await decided([leaving('areas', ['step 1', 'pays'], 'src/todos changed'), leaving('jev', ['refunds']), boom]);
    expect(records).toEqual([
      { name: 'areas', candidates: 4, excluded: 1, note: 'src/todos changed' },
      { name: 'jev', candidates: 2, excluded: 1 },
      { name: 'boom', candidates: 1, excluded: 0, note: 'failed, so it leaves nothing out: kaboom', outcome: 'failed' },
    ]);
    expect(summaries).toEqual(['areas kept 3 of 4 tests, left out 1 (src/todos changed)', 'jev kept 1 of 2 tests, left out 1', undefined]);
    expect(filterSummary({ name: 'slow', candidates: 2, excluded: 0, outcome: 'timed-out' })).toBeUndefined();
  });
});
