/**
 * Test filters (`filters`): the candidates a filter is handed and the setup
 * file each one's session comes from, filters composed in order, what a
 * result may name and every way one is refused, redaction and bounds on what
 * a filter writes, how a throw, an interrupt, or the deadline surfaces, and
 * the record and summary line of what each one decided.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import { collectFromRegistration, type Collection } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { select, type SelectionFilters } from '../../src/collect/select.ts';
import { resolveConfig, type ResolvedConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { ConfigurationError, E2EError } from '../../src/internal/errors.ts';
import { applyTestFilters, FILTER_TIMEOUT_MS, filterCandidates, filterRecords, filterSummary, sessionSetupFiles, type TestFilterScope } from '../../src/run/test-filters.ts';
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
    const engine = defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, state: { capture: async () => ({ format: 'toy', version: 1, data: {} }), restore: async () => undefined } });
    const cfg = resolveConfig(
      {
        targets: [
          { name: 'web', platform: 'web', engine },
          { name: 'web-2', platform: 'web', engine },
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

  it('offers a test one target runs even when another target leaves it out, in report order', async () => {
    const col = await collection(() => {
      test('on ios only', { platforms: ['ios'] }, noop);
      test('anywhere', noop);
    });
    const cfg = config({ targets: [{ name: 'web', platform: 'web' }, { name: 'ios', platform: 'ios' }] });
    expect(filterCandidates(select(col, cfg)).map(titleOf)).toEqual(['on ios only', 'anywhere']);
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
});

describe('sessionSetupFiles', () => {
  it('names the file of the setup test that saves each candidate session, and none for a test without one or one the selection leaves out', async () => {
    const setups = await collection(() => {
      test.setup('sign in', { sessions: ['member', 'admin'] }, noop);
    }, 'tests/auth.setup.e2e.ts');
    const pages = await collection(() => {
      test('member page', { session: 'member' }, noop);
      test('admin page', { session: 'admin', tags: ['slow'] }, noop);
      test('guest page', noop);
    }, 'tests/pages.e2e.ts');
    const col: Collection = { ...setups, files: [...setups.files, ...pages.files], tests: [...setups.tests, ...pages.tests] };
    const engine = defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, state: { capture: async () => ({ format: 'toy', version: 1, data: {} }), restore: async () => undefined } });
    const selection = select(col, config({ targets: [{ name: 'web', platform: 'web', engine }] }), { excludeTags: ['slow'] });
    const member = col.tests.find((entry) => entry.title === 'member page')!.id;
    expect(sessionSetupFiles(selection)).toEqual(new Map([[member, 'tests/auth.setup.e2e.ts']]));
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

  it('hands a filter a frozen list and a context of the project root, the change, the signal, log, and redact', async () => {
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
    expect(Object.keys(received!.context).toSorted()).toEqual(['changes', 'log', 'projectRoot', 'redact', 'signal']);
    expect(received!.context.projectRoot).toBe(ROOT);
    expect(received!.context.changes).toBe(CHANGES);
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

  it('cuts a reason, a note, and a log line to 1024 code points, never through an emoji', async () => {
    const candidates = await candidatesOf('a', 'b');
    const long = '😀'.repeat(2000);
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
    const cut = `${'😀'.repeat(1023)}…`;
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
    expect((await rejection(applyTestFilters([threw], candidates, value))).code).toBe('FILTER_FAILED');
    for (const log of logs) log('too late');
    expect(logs).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it('keeps a reason, a note, and a log line on one line', async () => {
    const candidates = await candidatesOf('a', 'b');
    const multiline = 'Gateway failed:\n\n  no key\n\tset one';
    const { scope: value, notices } = scope();
    const applied = await applyTestFilters(
      [
        filterOf('areas', (_tests, { log }) => {
          log(multiline);
          return { exclude: { [idOf(candidates, 'a')]: multiline }, note: multiline };
        }),
      ],
      candidates,
      value,
    );
    const line = 'Gateway failed: no key set one';
    expect(applied.excluded.get(idOf(candidates, 'a'))!.reason).toBe(line);
    expect(applied.decisions[0]!.note).toBe(line);
    expect(notices).toEqual([`areas: ${line}`]);
  });

  describe('ignores an id it was not given whose test is collected, since that test\'s fate is settled', () => {
    it('a setup test and a test another flag left out, leaving out only the tests it was given', async () => {
      const candidates = await candidatesOf('a', 'b');
      const setup = 'tests/auth.setup.e2e.ts::sign%20in';
      const sharded = 'tests/z.e2e.ts::outside%20the%20shard';
      const { scope: value } = scope({ collectedIds: new Set([...candidates.map((candidate) => candidate.id), setup, sharded]) });
      const filter = filterOf('areas', () => ({ exclude: { [setup]: 'not needed', [idOf(candidates, 'b')]: 'unaffected', [sharded]: 'unaffected' } }));
      const applied = await applyTestFilters([filter], candidates, value);
      expect([...applied.excluded]).toEqual([[idOf(candidates, 'b'), { filter: 'areas', reason: 'unaffected' }]]);
      expect(applied.decisions).toEqual([{ name: 'areas', candidates: 2 }]);
    });

    it('a test an earlier filter left out, which keeps that filter\'s reason', async () => {
      const candidates = await candidatesOf('a', 'b');
      const a = idOf(candidates, 'a');
      const filters = [filterOf('areas', () => ({ exclude: { [a]: 'first' } })), filterOf('jev', () => ({ exclude: { [a]: 'again' } }))];
      // As in a run, every collected test is in collectedIds, the one left out too.
      const applied = await applyTestFilters(filters, candidates, scope({ collectedIds: new Set(candidates.map((candidate) => candidate.id)) }).scope);
      expect([...applied.excluded]).toEqual([[a, { filter: 'areas', reason: 'first' }]]);
      expect(applied.decisions).toEqual([
        { name: 'areas', candidates: 2 },
        { name: 'jev', candidates: 1 },
      ]);
    });
  });

  describe('refuses a result that is not { exclude, note? } with FILTER_FAILED', () => {
    /** The error `answer` fails the `areas` filter with, over tests a, b, and c. */
    async function refusal(answer: (candidates: readonly TestFilterCandidate[]) => unknown, overrides: Partial<TestFilterScope> = {}): Promise<E2EError> {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const filter = filterOf('areas', () => invalid<TestFilterResult>(answer(candidates)));
      return rejection(applyTestFilters([filter], candidates, scope(overrides).scope));
    }
    const PREFIX = 'filter "areas" returned an invalid result: ';
    /** The refusal of any key but exclude and note. */
    const UNKNOWN = ": a filter returns { exclude: { [test.id]: reason }, note? }, and every test it doesn't name runs";
    /** The refusal of an id no collected test has. */
    const STRANGER = ', which no collected test has; exclude takes test.id';

    it.each([
      ['null', () => null, 'expected { exclude, note? }, got null'],
      ['undefined', () => undefined, 'expected { exclude, note? }, got undefined'],
      ['an array', () => [], 'expected { exclude, note? }, got an array'],
      ['a string', () => 'all', 'expected { exclude, note? }, got "all"'],
      ['a keep list', () => ({ keep: [] }), `unknown key "keep"${UNKNOWN}`],
      ['an include map, never pointed at exclude', () => ({ include: {} }), `unknown key "include"${UNKNOWN}`],
      ['a misspelled key', () => ({ exlude: {} }), `unknown key "exlude"${UNKNOWN}`],
      ['two unknown keys, naming the first', () => ({ exclude: {}, why: '', because: '' }), `unknown key "why"${UNKNOWN}`],
      ['no exclude', () => ({ note: 'nothing' }), 'exclude must be a plain object of test ids to reasons, got undefined'],
      ['an exclude list', () => ({ exclude: ['x'] }), 'exclude must be a plain object of test ids to reasons, got an array'],
      ['an exclude map', () => ({ exclude: new Map() }), 'exclude must be a plain object of test ids to reasons, got an object'],
      ['a numeric note', () => ({ exclude: {}, note: 3 }), 'note must be a string, got 3'],
    ])('%s', async (_label, answer, issue) => {
      const error = await refusal(answer);
      expect(error.code).toBe('FILTER_FAILED');
      expect(error.category).toBe('infrastructure');
      expect(error.message).toBe(`${PREFIX}${issue}`);
    });

    it('inside the filter\'s step, which then fails as it does for a throw', async () => {
      const candidates = await candidatesOf('a');
      const finished: string[] = [];
      const { scope: value } = scope({
        step: async (name, work) => {
          const result = await work();
          finished.push(name);
          return result;
        },
      });
      const error = await rejection(applyTestFilters([filterOf('areas', () => invalid<TestFilterResult>({ exclude: { nope: 'x' } }))], candidates, value));
      expect(error.code).toBe('FILTER_FAILED');
      expect(finished).toEqual([]);
      await applyTestFilters([filterOf('areas', () => ({ exclude: {} }))], candidates, value);
      expect(finished).toEqual(['areas']);
    });

    it('a reason that is not a non-empty string, naming the first test', async () => {
      for (const reason of ['', '   ', 42, null]) {
        const error = await refusal((candidates) => ({ exclude: { [idOf(candidates, 'pays')]: reason } }));
        expect(error.code).toBe('FILTER_FAILED');
        expect(error.message).toMatch(new RegExp(`^${PREFIX}the reason for ".+::pays" must be a non-empty string, got `));
      }
      const two = await refusal((candidates) => ({ exclude: { [idOf(candidates, 'pays')]: '', [idOf(candidates, 'refunds')]: 7 } }));
      expect(two.message).toContain('::pays" must be a non-empty string, got ""');
    });

    it('an id no collected test has, a title or a mistyped id among them, saying exclude takes test.id', async () => {
      const candidates = await candidatesOf('signs in', 'pays', 'refunds');
      const id = idOf(candidates, 'pays');
      const typo = await refusal(() => ({ exclude: { [`${id}x`]: 'nope' } }), { collectedIds: new Set(candidates.map((candidate) => candidate.id)) });
      expect(typo.code).toBe('FILTER_FAILED');
      expect(typo.message).toBe(`${PREFIX}exclude names ${JSON.stringify(`${id}x`)}${STRANGER}`);
      const title = await refusal(() => ({ exclude: { pays: 'unaffected' } }));
      expect(title.message).toBe(`${PREFIX}exclude names "pays"${STRANGER}`);
      const several = await refusal(() => ({ exclude: { 'tests/zz.e2e.ts::nothing': 'a', 'tests/zz.e2e.ts::else': 'b' } }));
      expect(several.message).toBe(`${PREFIX}exclude names "tests/zz.e2e.ts::nothing"${STRANGER}`);
    });

    it('quotes at most 200 code points of a key or an id it chose', async () => {
      const long = '😀'.repeat(20_000);
      const quoted = `"${'😀'.repeat(199)}…"`;
      const id = await refusal(() => ({ exclude: { [long]: 'r' } }));
      expect(id.message).toBe(`${PREFIX}exclude names ${quoted}${STRANGER}`);
      const key = await refusal(() => ({ exclude: {}, [long]: 1 }));
      expect(key.message).toBe(`${PREFIX}unknown key ${quoted}${UNKNOWN}`);
    });

    it('redacts and cuts what it echoes, like a reason: a secret as an id, a key, or the whole answer', async () => {
      /** `message` with each secret marker as `<secret>`, so the rest compares exactly. */
      const unmarked = (message: string) => message.replaceAll(/<secret:[^>]+>/gu, '<secret>');
      const id = await refusal(() => ({ exclude: { [SECRET]: 'r' } }));
      expect(unmarked(id.message)).toBe(`${PREFIX}exclude names "<secret>"${STRANGER}`);
      const key = await refusal(() => ({ exclude: {}, [PASSWORD]: 'r' }));
      expect(unmarked(key.message)).toBe(`${PREFIX}unknown key "<secret>"${UNKNOWN}`);
      const answer = await refusal(() => `${SECRET}\n${'x'.repeat(5000)}`);
      expect(answer.message).toMatch(new RegExp(`^${PREFIX}expected \\{ exclude, note\\? \\}, got "<secret:[^>]+>\\\\nx+…$`));
      const issue = answer.message.slice(PREFIX.length);
      expect([...issue]).toHaveLength(1024);
      for (const error of [id, key, answer]) expect(error.message).not.toContain(SECRET);
    });

    it('a result that throws as it is read, redacted', async () => {
      const getter = await refusal(() => ({
        get exclude(): never {
          throw new Error(`no diff for ${SECRET}`);
        },
      }));
      expect(getter).toMatchObject({ code: 'FILTER_FAILED', category: 'infrastructure' });
      expect(getter.message).toMatch(new RegExp(`^${PREFIX}no diff for <secret:[^>]+>$`));
      expect(getter.cause).toBeInstanceOf(Error);
      const trap = await refusal(
        () =>
          new Proxy(
            {},
            {
              ownKeys() {
                throw new TypeError('the proxy was revoked');
              },
            },
          ),
      );
      expect(trap).toMatchObject({ code: 'FILTER_FAILED', message: `${PREFIX}the proxy was revoked` });
      const configuration = await refusal(() => ({
        get exclude(): never {
          throw new ConfigurationError('INVALID_CONFIG', `bad token ${SECRET}`);
        },
      }));
      expect(configuration).toMatchObject({ code: 'FILTER_FAILED', category: 'infrastructure' });
      expect(configuration.message).toMatch(new RegExp(`^${PREFIX}bad token <secret:[^>]+>$`));
    });
  });

  describe('maps what a filter throws', () => {
    /** What `areas` throwing `thrown` rejects with. */
    async function thrownBy(thrown: unknown): Promise<E2EError> {
      const candidates = await candidatesOf('a');
      return rejection(applyTestFilters([filterOf('areas', async () => Promise.reject(thrown))], candidates, scope().scope));
    }

    it('a plain error becomes FILTER_FAILED with the error as its cause, redacted', async () => {
      const thrown = new Error(`git diff failed with ${SECRET}`);
      const error = await thrownBy(thrown);
      expect(error).toMatchObject({ code: 'FILTER_FAILED', category: 'infrastructure', name: 'InfrastructureError' });
      expect(error.message).toMatch(/^filter "areas" failed: git diff failed with <secret:[^>]+>$/);
      expect(error.cause).toBe(thrown);
    });

    it('a synchronous throw is FILTER_FAILED too', async () => {
      const candidates = await candidatesOf('a');
      const error = await rejection(
        applyTestFilters(
          [
            filterOf('areas', () => {
              throw new TypeError('tests.map is not a function');
            }),
          ],
          candidates,
          scope().scope,
        ),
      );
      expect(error.code).toBe('FILTER_FAILED');
      expect(error.message).toBe('filter "areas" failed: tests.map is not a function');
    });

    it('a model answer the agent could not use is FILTER_FAILED, never a test failure', async () => {
      const thrown = new AgentError('MODEL_OUTPUT_INVALID', 'the model answered with no decision');
      expect(thrown.category).toBe('test');
      const error = await thrownBy(thrown);
      expect(error).toMatchObject({ code: 'FILTER_FAILED', category: 'infrastructure' });
      expect(error.cause).toBe(thrown);
    });

    it('a configuration error keeps its code under the filter name', async () => {
      const thrown = new ConfigurationError('MODEL_UNAVAILABLE', `no key for ${PASSWORD}`);
      const error = await thrownBy(thrown);
      expect(error).toMatchObject({ code: 'MODEL_UNAVAILABLE', category: 'configuration', name: 'ConfigurationError' });
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.message).toMatch(/^filter "areas": no key for <secret:[^>]+>$/);
      expect(error.cause).toBe(thrown);
      // A configuration error of another class, as another copy of e2e throws, comes back as this copy's ConfigurationError.
      const foreign = new E2EError('configuration', 'INVALID_CONFIG', 'the areas map is empty');
      const rewrapped = await thrownBy(foreign);
      expect(rewrapped).toBeInstanceOf(ConfigurationError);
      expect(rewrapped).toMatchObject({ code: 'INVALID_CONFIG', message: 'filter "areas": the areas map is empty', cause: foreign });
    });
  });

  describe('interrupts', () => {
    it('abandons a filter that never settles and ignores its signal, as INTERRUPTED', async () => {
      const candidates = await candidatesOf('a');
      const controller = new AbortController();
      const started = vi.fn();
      const hanging = filterOf('slow', () => {
        started();
        return new Promise<TestFilterResult>(() => undefined);
      });
      const pending = rejection(applyTestFilters([hanging], candidates, scope({ signal: controller.signal }).scope));
      await vi.waitFor(() => expect(started).toHaveBeenCalled());
      controller.abort();
      const error = await pending;
      expect(error).toMatchObject({ code: 'INTERRUPTED', category: 'interrupted', message: 'interrupted while filter "slow" ran' });
    });

    it('records the call an interrupt abandoned as work left behind, so the CLI exits once a watch session that cancelled it quits', async () => {
      const candidates = await candidatesOf('a');
      const controller = new AbortController();
      const started = vi.fn();
      const hanging = filterOf('slow', () => {
        started();
        return new Promise<TestFilterResult>(() => undefined);
      });
      leaveWorkBehind.mockClear();
      const pending = rejection(applyTestFilters([hanging], candidates, scope({ signal: controller.signal }).scope));
      await vi.waitFor(() => expect(started).toHaveBeenCalled());
      expect(leaveWorkBehind).not.toHaveBeenCalled();
      controller.abort();
      expect((await pending).code).toBe('INTERRUPTED');
      expect(leaveWorkBehind).toHaveBeenCalledTimes(1);

      // No call began, so none was left behind.
      leaveWorkBehind.mockClear();
      expect((await rejection(applyTestFilters([hanging], candidates, scope({ signal: controller.signal }).scope))).code).toBe('INTERRUPTED');
      expect(leaveWorkBehind).not.toHaveBeenCalled();
    });

    it('reads a filter that rejects once aborted as the interrupt, never FILTER_FAILED', async () => {
      const candidates = await candidatesOf('a');
      const controller = new AbortController();
      const obedient = filterOf('jev', (_tests, { signal }) => {
        controller.abort();
        return Promise.reject(signal.reason as Error);
      });
      const error = await rejection(applyTestFilters([obedient], candidates, scope({ signal: controller.signal }).scope));
      expect(error.code).toBe('INTERRUPTED');
    });

    it('drops what a filter that ignores its signal keeps logging once its call is abandoned', async () => {
      const candidates = await candidatesOf('a');
      const controller = new AbortController();
      let log: TestFilterContext['log'] | undefined;
      const hanging = filterOf('slow', (_tests, context) => {
        log = context.log;
        context.log('asking about a');
        return new Promise<TestFilterResult>(() => undefined);
      });
      const { scope: value, notices } = scope({ signal: controller.signal });
      const pending = rejection(applyTestFilters([hanging], candidates, value));
      await vi.waitFor(() => expect(log).toBeDefined());
      controller.abort();
      expect((await pending).code).toBe('INTERRUPTED');
      log!('still asking about a');
      log!('and again');
      expect(notices).toEqual(['slow: asking about a']);
    });

    it('calls no filter once the run is interrupted', async () => {
      const candidates = await candidatesOf('a');
      const controller = new AbortController();
      controller.abort();
      const never = vi.fn(() => ({ exclude: {} }));
      const error = await rejection(applyTestFilters([filterOf('areas', never)], candidates, scope({ signal: controller.signal }).scope));
      expect(error).toMatchObject({ code: 'INTERRUPTED', message: 'interrupted while filter "areas" ran' });
      expect(never).not.toHaveBeenCalled();
    });
  });
});

describe('a filter past the deadline', () => {
  /** A filter that records its signal and never settles, whatever the signal says. */
  function hanging(name: string) {
    const seen: AbortSignal[] = [];
    const filter: TestFilter = {
      name,
      filter: (_tests, { signal }) => {
        seen.push(signal);
        return new Promise<TestFilterResult>(() => undefined);
      },
    };
    return { filter, seen };
  }

  it('is abandoned at its deadline with a TimeoutError on its signal, leaves nothing out, and the next filter judges every test', async () => {
    const candidates = await candidatesOf('a', 'b');
    const slow = hanging('slow');
    const later = vi.fn((tests: readonly TestFilterCandidate[]) => ({ exclude: { [tests[0]!.id]: 'unaffected' } }));
    const ended: string[] = [];
    const { scope: value, steps } = scope({
      timeoutMs: 50,
      step: async (name, work) => {
        steps.push(name);
        const call = await work();
        ended.push(`${name}: ${call.timedOut ? 'timed out' : 'done'}`);
        return call;
      },
    });
    vi.useFakeTimers();
    try {
      const pending = applyTestFilters([slow.filter, filterOf('later', later)], candidates, value);
      await vi.advanceTimersByTimeAsync(49);
      expect(later).not.toHaveBeenCalled();
      expect(slow.seen[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const applied = await pending;
      expect(slow.seen[0]!.aborted).toBe(true);
      expect(slow.seen[0]!.reason).toMatchObject({ name: 'TimeoutError', message: 'filter "slow" did not finish within 50ms' });
      expect(later).toHaveBeenCalledWith(candidates, expect.anything());
      expect(steps).toEqual(['slow', 'later']);
      expect(ended).toEqual(['slow: timed out', 'later: done']);
      expect(applied.decisions[0]).toEqual({ name: 'slow', candidates: 2, note: 'did not finish within 50ms: running every test it was given', timedOut: true });
      expect([...applied.excluded.keys()]).toEqual([idOf(candidates, 'a')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits the scope deadline, 300000 ms by default', async () => {
    expect(FILTER_TIMEOUT_MS).toBe(300_000);
    const candidates = await candidatesOf('a');
    const slow = hanging('slow');
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = applyTestFilters([slow.filter], candidates, scope().scope).then((applied) => {
        settled = true;
        return applied;
      });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).decisions[0]).toMatchObject({ timedOut: true, note: 'did not finish within 5m: running every test it was given' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a filter that rejects with its own deadline as timed out, never FILTER_FAILED, and ignores an answer that comes later', async () => {
    const candidates = await candidatesOf('a');
    let late: ((result: TestFilterResult) => void) | undefined;
    const obedient: TestFilter = {
      name: 'jev',
      filter: (_tests, { signal }) =>
        new Promise<TestFilterResult>((resolve, reject) => {
          late = resolve;
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    };
    const applied = await applyTestFilters([obedient], candidates, scope({ timeoutMs: 20 }).scope);
    late!({ exclude: { [idOf(candidates, 'a')]: 'too late' } });
    expect(applied.decisions[0]).toMatchObject({ name: 'jev', timedOut: true });
    expect(applied.excluded.size).toBe(0);
  });

  it('still ends INTERRUPTED when the run is interrupted before the deadline', async () => {
    const candidates = await candidatesOf('a');
    const controller = new AbortController();
    const slow = hanging('slow');
    const pending = rejection(applyTestFilters([slow.filter], candidates, scope({ signal: controller.signal, timeoutMs: 60_000 }).scope));
    await vi.waitFor(() => expect(slow.seen).toHaveLength(1));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'INTERRUPTED', message: 'interrupted while filter "slow" ran' });
    expect(slow.seen[0]!.reason).not.toMatchObject({ name: 'TimeoutError' });
  });

  it('records timedOut and prints the note as a warning as it gives up the call, with no summary line after', async () => {
    const candidates = await candidatesOf('a', 'b');
    const { scope: value, notices } = scope({ timeoutMs: 10 });
    const applied = await applyTestFilters([hanging('slow').filter], candidates, value);
    expect(notices).toEqual(['warning: slow did not finish within 10ms: running every test it was given']);
    const col = await collection(() => {
      test('a', noop);
      test('b', noop);
    });
    const records = filterRecords(applied.decisions, select(col, config(), { excluded: applied.excluded }, { passWithNoTests: true }));
    expect(records).toEqual([{ name: 'slow', candidates: 2, excluded: 0, note: 'did not finish within 10ms: running every test it was given', timedOut: true }]);
    expect(filterSummary(records[0]!)).toBeUndefined();
  });

  it('warns and records the work it left behind at once, so both hold when a later filter fails', async () => {
    const candidates = await candidatesOf('a', 'b');
    leaveWorkBehind.mockClear();
    await applyTestFilters([filterOf('quick', () => ({ exclude: {} }))], candidates, scope().scope);
    expect(leaveWorkBehind).not.toHaveBeenCalled();

    const { scope: value, notices } = scope({ timeoutMs: 10 });
    const boom = filterOf('boom', () => {
      expect(leaveWorkBehind).toHaveBeenCalledTimes(1);
      throw new Error('kaboom');
    });
    const error = await rejection(applyTestFilters([hanging('slow').filter, boom], candidates, value));
    expect(error).toMatchObject({ code: 'FILTER_FAILED', message: 'filter "boom" failed: kaboom' });
    expect(notices).toEqual(['warning: slow did not finish within 10ms: running every test it was given']);
    expect(leaveWorkBehind).toHaveBeenCalledTimes(1);
  });
});

describe('filterRecords and filterSummary', () => {
  /** A suite with a serial group, decided by `filters` and selected again with what they left out. */
  async function decided(filters: readonly TestFilter[], extra: SelectionFilters = {}) {
    const col = await collection(() => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
      test('pays', noop);
      test('refunds', noop);
    });
    const cfg = config({ targets: [{ name: 'web', platform: 'web' }, { name: 'web-2', platform: 'web' }] });
    const candidates = filterCandidates(select(col, cfg));
    const applied = await applyTestFilters(filters, candidates, scope().scope);
    const selection = select(col, cfg, { ...extra, excluded: applied.excluded }, { passWithNoTests: true });
    const records = filterRecords(applied.decisions, selection);
    return { candidates, applied, selection, records, summaries: records.map((record) => filterSummary(record)) };
  }
  /** Excludes the tests titled `titles`, with one reason. */
  const leaving = (name: string, titles: readonly string[], note?: string): TestFilter =>
    filterOf(name, (tests) => ({
      exclude: Object.fromEntries(tests.filter((entry) => titles.includes(titleOf(entry))).map((entry) => [entry.id, 'unaffected'])),
      ...(note === undefined ? {} : { note }),
    }));

  it('counts distinct tests the final selection leaves out, once across targets, after the serial group took its member back', async () => {
    const { records, summaries, selection } = await decided([leaving('areas', ['step 1', 'pays'], 'src/todos changed')]);
    expect(records).toEqual([{ name: 'areas', candidates: 4, excluded: 1, note: 'src/todos changed' }]);
    expect(summaries).toEqual(['areas kept 3 of 4 tests, left out 1 (src/todos changed)']);
    const running = selection.pairs.filter((pair) => pair.disposition === 'run').map((pair) => `${pair.test.title} [${pair.target.name}]`);
    expect(running).toEqual(['step 1 [web]', 'step 2 [web]', 'refunds [web]', 'step 1 [web-2]', 'step 2 [web-2]', 'refunds [web-2]']);
  });

  it('drops a serial group the filter left out whole, with nothing staying in', async () => {
    const { summaries, selection } = await decided([leaving('areas', ['step 1', 'step 2', 'pays'])]);
    expect(summaries).toEqual(['areas kept 1 of 4 tests, left out 3']);
    expect(selection.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title)).toEqual(['refunds', 'refunds']);
  });

  it('keeps a serial group whose member the filter kept, even one only the closure had brought in', async () => {
    const { selection } = await decided([leaving('areas', ['step 1', 'pays'])], { grep: [/step 1|pays|refunds/] });
    const running = selection.pairs.filter((pair) => pair.disposition === 'run' && pair.target.name === 'web').map((pair) => pair.test.title);
    expect(running).toEqual(['step 1', 'step 2', 'refunds']);
  });

  it('reads a filter that kept everything or left everything out, with its note', async () => {
    const kept = await decided([filterOf('jev', () => ({ exclude: {}, note: 'not a pull request: running every test' }))]);
    expect(kept.records[0]).toMatchObject({ name: 'jev', candidates: 4, excluded: 0 });
    expect(kept.summaries).toEqual(['jev kept all 4 tests (not a pull request: running every test)']);
    const none = await decided([leaving('areas', ['step 1', 'step 2', 'pays', 'refunds'])]);
    expect(none.records[0]).toMatchObject({ name: 'areas', candidates: 4, excluded: 4 });
    expect(none.summaries).toEqual(['areas left out all 4 tests']);
    expect(none.selection.pairs.every((pair) => pair.disposition === 'filtered' && pair.skip?.filter === 'areas')).toBe(true);
  });

  it('records each filter on its own input, the later one seeing what the earlier kept', async () => {
    const { records, summaries } = await decided([leaving('areas', ['pays']), leaving('jev', ['refunds'])]);
    expect(records.map(({ name, candidates, excluded }) => ({ name, candidates, excluded }))).toEqual([
      { name: 'areas', candidates: 4, excluded: 1 },
      { name: 'jev', candidates: 3, excluded: 1 },
    ]);
    expect(summaries).toEqual(['areas kept 3 of 4 tests, left out 1', 'jev kept 2 of 3 tests, left out 1']);
  });

  it('says test, not tests, for one', () => {
    expect(filterSummary({ name: 'areas', candidates: 1, excluded: 0 })).toBe('areas kept all 1 test');
    expect(filterSummary({ name: 'areas', candidates: 1, excluded: 1 })).toBe('areas left out all 1 test');
    expect(filterSummary({ name: 'areas', candidates: 3, excluded: 1 })).toBe('areas kept 2 of 3 tests, left out 1');
  });
});
