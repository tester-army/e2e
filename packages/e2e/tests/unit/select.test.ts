import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectFromRegistration, type Collection } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { repeatEach, resolveOptions, select } from '../../src/collect/select.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { resultId } from '../../src/internal/ids.ts';
import type { E2EConfig } from '../../src/types.ts';

const noop = async () => {};
const ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

async function collection(
  body: () => void,
  file = 'tests/a.e2e.ts',
  unmatchedPositionals: readonly string[] = [],
): Promise<Collection> {
  const registration = await collectModule(async () => body());
  // Positionals that matched nothing leave the discovered file collected but unselected.
  const collected = collectFromRegistration('/root', `/root/${file}`, registration, unmatchedPositionals.length === 0);
  return { files: [collected], tests: collected.tests, nearMisses: [], unmatchedPositionals, uncollected: [] };
}

/** Several files collected together, with `selected` naming the ones positionals chose (all by default). */
async function collectionOf(
  modules: readonly { readonly file: string; readonly body: () => void }[],
  selected?: readonly string[],
): Promise<Collection> {
  const files = [];
  for (const module of modules) {
    const registration = await collectModule(async () => module.body());
    files.push(collectFromRegistration('/root', `/root/${module.file}`, registration, selected === undefined || selected.includes(module.file)));
  }
  return { files, tests: files.flatMap((entry) => entry.tests), nearMisses: [], unmatchedPositionals: [], uncollected: [] };
}

/** A collection whose globs matched nothing, with optional look-alike files. */
function emptyCollection(nearMisses: readonly string[] = []): Collection {
  return { files: [], tests: [], nearMisses, unmatchedPositionals: [], uncollected: [] };
}

function config(raw: Partial<E2EConfig> = {}, env: NodeJS.ProcessEnv = ENV) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], ...raw }, { projectRoot: '/root', env });
}

/** `config()` with command-line overrides, the way `--agent` reaches selection. */
function configWith(raw: Partial<E2EConfig>, cli: NonNullable<Parameters<typeof resolveConfig>[1]['cli']>) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], ...raw }, { projectRoot: '/root', env: ENV, cli });
}

describe('resolveOptions', () => {
  it('pins a test to a configured agent, innermost wins, and rejects a name agents does not define', async () => {
    const agents = { agents: { default: {}, buyer: { context: 'buyer' }, admin: { context: 'admin' } } };
    const col = await collection(() => {
      test.describe('as a buyer', { agent: 'buyer' }, () => {
        test('browses', noop);
        test.describe('refunds', { agent: 'admin' }, () => {
          test('refunds', noop);
          test('as the buyer again', { agent: 'buyer' }, noop);
        });
      });
      test('unpinned', noop);
    });
    const cfg = config(agents);
    const pins = col.tests.map((entry) => resolveOptions(entry, cfg).agents);
    expect(pins).toEqual([['buyer'], ['admin'], ['buyer'], ['default']]);

    const unknown = await collection(() => {
      test('elsewhere', { agent: 'buyr' }, noop);
    });
    expect(() => resolveOptions(unknown.tests[0]!, cfg)).toThrow(
      /test "elsewhere" in tests\/a\.e2e\.ts names agent "buyr", which agents does not define; configured: default, buyer, admin; did you mean "buyer"\?/,
    );
  });

  it('rejects an empty agent name at registration', async () => {
    await expect(collection(() => { test('x', { agent: '' }, noop); })).rejects.toThrow(/test options: agent must be the name of a configured agent/);
  });

  it('rejects an empty, repeated, or blank-entry agent list at registration', async () => {
    await expect(collection(() => { test('x', { agent: [] }, noop); })).rejects.toThrow(/non-empty list of names/);
    await expect(collection(() => { test('x', { agent: ['a', 'a'] }, noop); })).rejects.toThrow(/agent lists each name once/);
    await expect(collection(() => { test('x', { agent: ['a', ''] }, noop); })).rejects.toThrow(/every entry of agent must be the name/);
  });

  it('runs a test once per pinned agent; --agent narrows a pin to the names both give and leaves a pin it misses whole', async () => {
    const agents = { agents: { default: {}, buyer: {}, admin: {}, guest: {}, thorough: {} } };
    const col = await collection(() => {
      test.describe('as each persona', { agent: ['buyer', 'admin', 'guest'] }, () => {
        test('checks out', noop);
        test('as the admin only', { agent: 'admin' }, noop);
      });
      test('unpinned', noop);
    });
    const agentsOf = (cfg: ReturnType<typeof config>) => col.tests.map((entry) => resolveOptions(entry, cfg).agents);

    // No flag: the pin as written, and `default` for the rest.
    expect(agentsOf(config(agents))).toEqual([['buyer', 'admin', 'guest'], ['admin'], ['default']]);
    const pairs = select(col, config(agents)).pairs;
    expect(pairs.filter((pair) => pair.test.title === 'checks out').map((pair) => pair.agent)).toEqual(['buyer', 'admin', 'guest']);
    expect(pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run', 'run', 'run']);

    // The flag names some of the pin: the pin narrows to those, in pin order.
    expect(agentsOf(configWith(agents, { agents: ['guest', 'admin'] }))).toEqual([['admin', 'guest'], ['admin'], ['guest', 'admin']]);

    // The flag names none of the pin: the pin stands, the unpinned test follows the flag.
    expect(agentsOf(configWith(agents, { agents: ['thorough'] }))).toEqual([['buyer', 'admin', 'guest'], ['admin'], ['thorough']]);
  });

  it('runs a setup test once per target, as its pin or the first run agent, and rejects a list on it', async () => {
    const col = await collection(() => {
      test.setup('sign in', { sessions: ['s'] }, noop);
      test.setup('sign in as admin', { sessions: ['a'], agent: 'admin' }, noop);
    });
    const cfg = configWith({ agents: { default: {}, buyer: {}, admin: {} } }, { agents: ['buyer', 'admin'] });
    expect(col.tests.map((entry) => resolveOptions(entry, cfg).agents)).toEqual([['buyer'], ['admin']]);
    await expect(
      collection(() => { test.setup('x', { sessions: ['s'], agent: ['a', 'b'] } as never, noop); }),
    ).rejects.toThrow(/setup test runs once per target and pins at most one agent/);
  });

  it('fans a serial group out per agent and rejects a member pinned away from its group', async () => {
    const agents = { agents: { default: {}, buyer: {}, admin: {} } };
    const col = await collection(() => {
      test.describe('wizard', { serial: true, agent: ['buyer', 'admin'] }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
    });
    const pairs = select(col, config(agents)).pairs;
    expect(pairs.map((pair) => [pair.test.title, pair.agent])).toEqual([
      ['step 1', 'buyer'],
      ['step 1', 'admin'],
      ['step 2', 'buyer'],
      ['step 2', 'admin'],
    ]);

    const uneven = await collection(() => {
      test.describe('wizard', { serial: true, agent: ['buyer', 'admin'] }, () => {
        test('step 1', noop);
        test('step 2', { agent: 'admin' }, noop);
      });
    });
    expect(() => select(uneven, config(agents))).toThrow(
      /serial group "wizard" in tests\/a\.e2e\.ts runs as agents \[buyer, admin\] but its member "step 2" pins \[admin\]; pin the agent on the serial describe/,
    );
  });

  it('resolves precedence: test > inner group > outer group > config', async () => {
    const col = await collection(() => {
      test.describe('outer', { timeout: 10_000, retries: 2, tags: ['outer'] }, () => {
        test.describe('inner', { timeout: 20_000, tags: ['inner'] }, () => {
          test('leaf', { timeout: 30_000, tags: ['leaf'] }, noop);
          test('inherits', noop);
        });
      });
    });
    const cfg = config({ timeout: 5_000 });
    const leaf = resolveOptions(col.tests[0]!, cfg);
    expect(leaf.timeout).toBe(30_000);
    expect(leaf.retries).toBe(2);
    expect([...col.tests[0]!.tags].toSorted()).toEqual(['inner', 'leaf', 'outer']);

    const inherits = resolveOptions(col.tests[1]!, cfg);
    expect(inherits.timeout).toBe(20_000);
  });

  it('concatenates agentContext outer-to-inner with newlines', async () => {
    const col = await collection(() => {
      test.describe('outer', { agentContext: 'outer ctx' }, () => {
        test('leaf', { agentContext: 'leaf ctx' }, noop);
      });
    });
    expect(resolveOptions(col.tests[0]!, config()).agentContext).toBe('outer ctx\nleaf ctx');
  });

  it('replaces platforms, requires, and session', async () => {
    const col = await collection(() => {
      test.describe('outer', { platforms: ['web'], requires: ['web'], session: 'a' }, () => {
        test('leaf', { session: 'b' }, noop);
      });
    });
    const options = resolveOptions(col.tests[0]!, config());
    expect(options.platforms).toEqual(['web']);
    expect(options.requires).toEqual(['web']);
    expect(options.session).toBe('b');
  });
});

describe('select', () => {
  it('marks explicit skips as skipped with cause explicit', async () => {
    const col = await collection(() => {
      test('runs', noop);
      test.skip('skipped', noop);
    });
    const selection = select(col, config());
    const skipped = selection.pairs.find((pair) => pair.test.title === 'skipped')!;
    expect(skipped.disposition).toBe('skip');
    expect(skipped.skip?.cause).toBe('explicit');
  });

  it('focuses .only tests and filters the rest', async () => {
    const col = await collection(() => {
      test('normal', noop);
      test.only('focused', noop);
    });
    const selection = select(col, config());
    const normal = selection.pairs.find((pair) => pair.test.title === 'normal')!;
    const focused = selection.pairs.find((pair) => pair.test.title === 'focused')!;
    expect(normal.disposition).toBe('filtered');
    expect(focused.disposition).toBe('run');
  });

  it('rejects .only in CI', async () => {
    const col = await collection(() => {
      test.only('focused', noop);
    });
    expect(() => select(col, config({}, { ...ENV, CI: '1' } as NodeJS.ProcessEnv))).toThrow(
      /\.only is rejected in CI/,
    );
  });

  it('applies tag filters with any/all modes', async () => {
    const col = await collection(() => {
      test('smoke', { tags: ['smoke'] }, noop);
      test('smoke+billing', { tags: ['smoke', 'billing'] }, noop);
      test('none', noop);
    });
    const anyMode = select(col, config(), { tags: ['smoke', 'billing'], tagMode: 'any' });
    expect(anyMode.pairs.filter((pair) => pair.disposition === 'run')).toHaveLength(2);

    const allMode = select(col, config(), { tags: ['smoke', 'billing'], tagMode: 'all' });
    const runnable = allMode.pairs.filter((pair) => pair.disposition === 'run');
    expect(runnable).toHaveLength(1);
    expect(runnable[0]!.test.title).toBe('smoke+billing');
  });

  it('leaves out tests carrying an excluded tag, whatever --tag selected', async () => {
    const col = await collection(() => {
      test('smoke', { tags: ['smoke'] }, noop);
      test('smoke but slow', { tags: ['smoke', 'slow'] }, noop);
      test('plain', noop);
    });
    const excluded = select(col, config(), { excludeTags: ['slow'] });
    expect(excluded.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title)).toEqual(['smoke', 'plain']);
    const slow = excluded.pairs.find((pair) => pair.test.title === 'smoke but slow')!;
    expect(slow.disposition).toBe('filtered');
    expect(slow.skip?.reason).toBe('carries an excluded tag');

    const both = select(col, config(), { tags: ['smoke'], excludeTags: ['slow'] });
    expect(both.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title)).toEqual(['smoke']);

    expect(() => select(col, config(), { tags: ['smoke'], excludeTags: ['smoke', 'nigthly'] })).toThrow(
      '3 tests were collected but none is runnable: 2 carry one of the excluded tags smoke, nigthly (no test declares it), 1 carry none of the tags smoke; pass --pass-with-no-tests to allow this',
    );
  });

  it('matches --grep and --grep-invert against the space-joined title path, any pattern of several', async () => {
    const col = await collection(() => {
      test.describe('checkout', () => {
        test('pays', noop);
        test('refunds', noop);
      });
      test('signs in', noop);
    });
    const titles = (selection: ReturnType<typeof select>) =>
      selection.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title);
    expect(titles(select(col, config(), { grep: [/^checkout pays$/] }))).toEqual(['pays']);
    expect(titles(select(col, config(), { grep: [/refund/, /signs/] }))).toEqual(['refunds', 'signs in']);
    expect(titles(select(col, config(), { grepInvert: [/checkout/] }))).toEqual(['signs in']);
    expect(titles(select(col, config(), { grep: [/checkout/], grepInvert: [/REFUND/i] }))).toEqual(['pays']);
    // A global pattern is matched from the start for every test, not from where its last match ended.
    expect(titles(select(col, config(), { grep: [/checkout/g] }))).toEqual(['pays', 'refunds']);
    // Empty pattern lists are no filter at all.
    expect(titles(select(col, config(), { grep: [], grepInvert: [] }))).toEqual(['pays', 'refunds', 'signs in']);

    const filtered = select(col, config(), { grep: [/pays/] }).pairs.find((pair) => pair.test.title === 'refunds')!;
    expect(filtered.skip?.reason).toBe('title does not match --grep');
    expect(() => select(col, config(), { grep: [/billing/, /admin/i] })).toThrow(
      '3 tests were collected but none is runnable: 3 have titles matching none of /billing/, /admin/i; pass --pass-with-no-tests to allow this',
    );
    expect(() => select(col, config(), { grepInvert: [/./] })).toThrow(
      '3 tests were collected but none is runnable: 3 have titles matching /./; pass --pass-with-no-tests to allow this',
    );
  });

  it('keeps only the tests the last run did not pass, by result id per target and agent', async () => {
    const col = await collection(() => {
      test('passed', noop);
      test('failed', noop);
      test('crashed', noop);
    });
    const cfg = configWith({ agents: { default: {}, admin: {} } }, { agents: ['default', 'admin'] });
    const failedId = (title: string, agent: string) => resultId(col.tests.find((entry) => entry.title === title)!.id, 'web', agent);
    const selection = select(col, cfg, { lastFailed: new Set([failedId('failed', 'default'), failedId('crashed', 'admin')]) });
    expect(selection.pairs.filter((pair) => pair.disposition === 'run').map((pair) => [pair.test.title, pair.agent])).toEqual([
      ['failed', 'default'],
      ['crashed', 'admin'],
    ]);
    expect(selection.pairs[0]!.skip?.reason).toBe('did not fail in the last run');
    expect(() => select(col, config(), { lastFailed: new Set() })).toThrow(
      '3 tests were collected but none is runnable: 3 did not fail in the last run, which had no failures; pass --pass-with-no-tests to allow this',
    );
  });

  it('keeps the consumers of a setup the last run did not pass, which brings the setup back', async () => {
    const col = await collection(() => {
      test.setup('sign in', { sessions: ['member'] }, noop);
      test('signed in', { session: 'member' }, noop);
      test('signed out', noop);
    });
    const idOf = (title: string) => resultId(col.tests.find((entry) => entry.title === title)!.id, 'web', 'default');
    const running = (lastFailed: ReadonlySet<string>) =>
      select(col, config(), { lastFailed }).pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title);
    expect(running(new Set([idOf('sign in')]))).toEqual(['sign in', 'signed in']);
    // Control: a failure elsewhere leaves the setup and its consumer out.
    expect(running(new Set([idOf('signed out')]))).toEqual(['signed out']);
  });

  it('cuts a shard from the selected tests after every other filter, keeping a serial group together', async () => {
    const col = await collection(() => {
      test('a', noop);
      test('b', { tags: ['slow'] }, noop);
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
      test('c', noop);
      test('d', noop);
    });
    const running = (selection: ReturnType<typeof select>) =>
      selection.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.test.title);
    // Five items once `b` is excluded: a, the wizard, c, d. Two shards split them 2 and 2.
    const first = select(col, config(), { excludeTags: ['slow'], shard: { index: 1, total: 2 } });
    expect(running(first)).toEqual(['a', 'step 1', 'step 2']);
    expect(first.pairs.find((pair) => pair.test.title === 'c')!.skip?.reason).toBe('outside the shard');
    expect(running(select(col, config(), { excludeTags: ['slow'], shard: { index: 2, total: 2 } }))).toEqual(['c', 'd']);
    // Three shards of four items: 2, 1, 1, the first shard taking the remainder, every item in exactly one.
    const shards = [1, 2, 3].map((index) => running(select(col, config(), { excludeTags: ['slow'], shard: { index, total: 3 } })));
    expect(shards).toEqual([['a', 'step 1', 'step 2'], ['c'], ['d']]);
    expect(() => select(col, config(), { grep: [/^a$/], shard: { index: 2, total: 2 } })).toThrow(
      '6 tests were collected but none is runnable: 1 fall outside shard 2/2 (1 test split across 2 shards), 5 have titles matching none of /^a$/; pass --pass-with-no-tests to allow this',
    );
  });

  it('brings only the setup tests a shard needs', async () => {
    const col = await collection(() => {
      test.setup('login', { sessions: ['user'] }, noop);
      test('anonymous', noop);
      test('signed in', { session: 'user' }, noop);
    });
    const setup = (selection: ReturnType<typeof select>) => selection.pairs.find((pair) => pair.test.kind === 'setup')!.disposition;
    expect(setup(select(col, config(), { shard: { index: 1, total: 2 } }))).toBe('filtered');
    expect(setup(select(col, config(), { shard: { index: 2, total: 2 } }))).toBe('run');
  });

  it('names the tag filter against the tags the suite declares', async () => {
    const col = await collection(() => {
      test('smoke', { tags: ['smoke'] }, noop);
      test('billing', { tags: ['billing'] }, noop);
    });
    expect(() => select(col, config(), { tags: ['smok'] })).toThrow(
      '2 tests were collected but none is runnable: 2 carry none of the tags smok (did you mean smoke?); pass --pass-with-no-tests to allow this',
    );
    expect(() => select(col, config(), { tags: ['smoke', 'billing'], tagMode: 'all' })).toThrow(
      '2 tests were collected but none is runnable: 2 do not carry all of the tags smoke, billing; pass --pass-with-no-tests to allow this',
    );
    expect(() => select(col, config(), { tags: ['nightly', 'biling'], tagMode: 'all' })).toThrow(
      '2 do not carry all of the tags nightly (no test declares it), biling (did you mean billing?); pass',
    );
  });

  it('blames the tag filter only for the tests it filtered', async () => {
    const narrowed = await collectionOf(
      [
        { file: 'tests/a.e2e.ts', body: () => { test('a', { tags: ['smoke'] }, noop); } },
        { file: 'tests/b.e2e.ts', body: () => { test('b', noop); } },
      ],
      ['tests/b.e2e.ts'],
    );
    expect(() => select(narrowed, config(), { tags: ['smoke'] })).toThrow(
      '2 tests were collected but none is runnable: 1 file not selected by a positional argument, 1 carry none of the tags smoke; pass --pass-with-no-tests to allow this',
    );
    const focused = await collection(() => {
      test.only('debug', noop);
      test('pays', { tags: ['billing'] }, noop);
    });
    expect(() => select(focused, config(), { tags: ['billing'] })).toThrow(
      '2 tests were collected but none is runnable: 1 carry none of the tags billing, 1 not focused by .only; pass --pass-with-no-tests to allow this',
    );
    const untagged = await collection(() => {
      test('plain', noop);
    });
    expect(() => select(untagged, config(), { tags: ['smoke'] })).toThrow(
      '1 tests were collected but none is runnable: 1 carry none of the tags smoke (no test declares it); pass --pass-with-no-tests to allow this',
    );
  });

  it('filters targets by platforms option', async () => {
    const col = await collection(() => {
      test('mobile only', { platforms: ['ios'] }, noop);
      test('web too', { platforms: ['web', 'ios'] }, noop);
    });
    const selection = select(col, config());
    const mobileOnly = selection.pairs.find((pair) => pair.test.title === 'mobile only')!;
    expect(mobileOnly.disposition).toBe('filtered');
    expect(mobileOnly.skip?.cause).toBe('platform-unavailable');
    expect(selection.pairs.find((pair) => pair.test.title === 'web too')!.disposition).toBe('run');
  });

  it('skips tests whose required capability is unavailable', async () => {
    const col = await collection(() => {
      test('needs device', { requires: ['device'] }, noop);
      test('needs web', { requires: ['web'] }, noop);
    });
    // Capabilities are the engine's declared set: harness tiers plus one name
    // per contributed fixture. This engine contributes `web`, not `device`.
    const engine = defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, fixtures: { web: () => ({}) } });
    const selection = select(col, config({ targets: [{ name: 'web', platform: 'web', engine }] }));
    const device = selection.pairs.find((pair) => pair.test.title === 'needs device')!;
    expect(device.disposition).toBe('skip');
    expect(device.skip?.cause).toBe('capability-unavailable');
    expect(selection.pairs.find((pair) => pair.test.title === 'needs web')!.disposition).toBe('run');
  });

  it('selects the session producer for consumers regardless of filters', async () => {
    const col = await collection(() => {
      test.setup('auth', { sessions: ['member'] }, noop);
      test('uses session', { session: 'member', tags: ['smoke'] }, noop);
    });
    const selection = select(col, config(), { tags: ['smoke'] });
    const setup = selection.pairs.find((pair) => pair.test.kind === 'setup')!;
    expect(setup.disposition).toBe('run');
  });

  it('fails when the consumed session\'s producer is filtered by its platform list', async () => {
    const col = await collection(() => {
      test.setup('auth', { sessions: ['member'], platforms: ['ios'] }, noop);
      test('uses session', { session: 'member' }, noop);
    });
    expect(() => select(col, config())).toThrow(/cannot run on target "web"/);
  });

  it('fails when a consumed session has no producer', async () => {
    const col = await collection(() => {
      test('uses session', { session: 'missing' }, noop);
    });
    expect(() => select(col, config())).toThrow(/no setup test produces it/);
  });

  it('names a file a narrowed run could not collect as where a missing producer may live', async () => {
    const col = await collection(() => {
      test('uses session', { session: 'member' }, noop);
    });
    const narrowed = { ...col, uncollected: [{ file: 'tests/auth.setup.e2e.ts', reason: 'boom' }] };
    expect(() => select(narrowed, config())).toThrow(
      /no setup test produces it; it may be declared in a file that failed to collect: tests\/auth\.setup\.e2e\.ts \(boom\)$/,
    );
  });

  it('caps the files named as where a missing producer may live', async () => {
    const col = await collection(() => {
      test('uses session', { session: 'member' }, noop);
    });
    const uncollected = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ file: `tests/${name}.e2e.ts`, reason: 'boom' }));
    expect(() => select({ ...col, uncollected }, config())).toThrow(
      /failed to collect: tests\/a\.e2e\.ts \(boom\), tests\/b\.e2e\.ts \(boom\), tests\/c\.e2e\.ts \(boom\) and 2 more$/,
    );
  });

  it('fails on duplicate session producers', async () => {
    const col = await collection(() => {
      test.setup('one', { sessions: ['member'] }, noop);
      test.setup('two', { sessions: ['member'] }, noop);
      test('t', noop);
    });
    expect(() => select(col, config())).toThrow(/duplicate producers/);
  });

  it('selects a complete serial group atomically under tag filters', async () => {
    const col = await collection(() => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', { tags: ['smoke'] }, noop);
        test('step 2', { tags: ['slow'] }, noop);
      });
    });
    const selection = select(col, config(), { tags: ['smoke'] });
    const step2 = selection.pairs.find((pair) => pair.test.title === 'step 2')!;
    expect(step2.disposition).toBe('run');
    expect(step2.skip).toBeUndefined();

    // A member another filter left out still runs with its group: the group is one unit.
    const grepped = select(col, config(), { grep: [/step 1/], excludeTags: ['slow'] });
    expect(grepped.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run']);
    // Excluding every member (a tag on the serial describe reaches them all) leaves the group out.
    expect(() => select(col, config(), { excludeTags: ['smoke', 'slow'] })).toThrow(/2 carry one of the excluded tags smoke, slow/);
  });

  it('errors on zero runnable ordinary pairs unless passWithNoTests', async () => {
    const col = await collection(() => {
      test.skip('skipped', noop);
    });
    expect(() => select(col, config())).toThrow(
      '1 tests were collected but none is runnable: 1 skipped with test.skip; pass --pass-with-no-tests to allow this',
    );
    expect(() => select(col, config(), {}, { passWithNoTests: true })).not.toThrow();
  });

  it('names the positionals that matched no file in the NO_TESTS message, with the nearest discovered file', async () => {
    const col = await collection(() => {}, 'tests/agent.e2e.ts', ['tests/agnet.e2e.ts', 'tests/*.spec.ts']);
    expect(() => select(col, config())).toThrow(
      'no test file matched tests/agnet.e2e.ts (did you mean tests/agent.e2e.ts?), tests/*.spec.ts; the config globs discovered tests/agent.e2e.ts; pass --pass-with-no-tests to allow this',
    );
    expect(() => select(col, config(), {}, { passWithNoTests: true })).not.toThrow();
  });

  it('offers the nearest discovered file name when the unmatched positional was a bare name', async () => {
    const col = await collection(() => {}, 'tests/agent.e2e.ts', ['agnet.e2e.ts']);
    expect(() => select(col, config())).toThrow(
      'no test file matched agnet.e2e.ts (did you mean agent.e2e.ts?); the config globs discovered tests/agent.e2e.ts; pass --pass-with-no-tests to allow this',
    );
  });

  it('explains empty discovery with the globs, the root, and any look-alike files', () => {
    expect(() => select(emptyCollection(), config())).toThrow(
      'no test file matched "tests/**/*.e2e.ts" under /root; create tests/example.e2e.ts (e2e init writes one), or set tests in the config; pass --pass-with-no-tests to allow this',
    );
    expect(() =>
      select(emptyCollection(['tests/login.test.ts', 'tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts']), config()),
    ).toThrow(
      'found tests/login.test.ts, tests/a.spec.ts, tests/b.spec.ts and 1 more, which the pattern does not match: rename to *.e2e.ts, or set tests in the config to a glob that matches',
    );
    expect(() => select(emptyCollection(), config(), {}, { passWithNoTests: true })).not.toThrow();
  });

  it('points at the import when a matched file registered no tests', async () => {
    const col = await collection(() => {});
    expect(() => select(col, config())).toThrow(
      "tests/a.e2e.ts registered no tests; import { test } from 'e2e' (or from the engine package) and call test() at the top level of the module",
    );
  });

  it('counts why collected tests are not runnable', async () => {
    const col = await collection(() => {
      test('mobile only', { platforms: ['ios'] }, noop);
      test.skip('later', noop);
      test.setup('login', { sessions: ['user'] }, noop);
    });
    expect(() => select(col, config())).toThrow(
      '3 tests were collected but none is runnable: 1 declare platforms other than web, 1 skipped with test.skip, 1 setup tests, which run only for the sessions selected tests need; pass --pass-with-no-tests to allow this',
    );
    // The tag filter is applied first, so under --tag it is the one reason.
    const tagged = await collection(() => {
      test('smoke', { tags: ['smoke'] }, noop);
      test('mobile only', { platforms: ['ios'] }, noop);
    });
    expect(() => select(tagged, config(), { tags: ['billing'] })).toThrow(
      '2 tests were collected but none is runnable: 2 carry none of the tags billing (no test declares it); pass --pass-with-no-tests to allow this',
    );
  });

  it('rejects unknown target IDs', async () => {
    const col = await collection(() => {
      test('x', noop);
    });
    expect(() => select(col, config(), { targetIds: ['nope'] })).toThrow(/unknown target/i);
    expect(() => select(col, config(), { targetIds: ['wbe'] })).toThrow(
      'unknown target ID "wbe"; the config declares "web"; did you mean "web"?',
    );
  });
});

describe('repeatEach', () => {
  it('runs every runnable ordinary pair n times, adjacent and numbered, and setups or left-out pairs once', async () => {
    const col = await collection(() => {
      test.setup('login', { sessions: ['user'] }, noop);
      test('a', { session: 'user' }, noop);
      test('b', { tags: ['slow'] }, noop);
      test.skip('c', noop);
    });
    const once = select(col, config(), { excludeTags: ['slow'] });
    expect(repeatEach(once, 1)).toBe(once);
    const thrice = repeatEach(once, 3);
    expect(thrice.pairs.map((pair) => [pair.test.title, pair.disposition, pair.repeat])).toEqual([
      ['login', 'run', 0],
      ['a', 'run', 0],
      ['a', 'run', 1],
      ['a', 'run', 2],
      ['b', 'filtered', 0],
      ['c', 'skip', 0],
    ]);
    expect(thrice.perTarget[0]!.pairs).toEqual(thrice.pairs);
  });
});

describe('positional file selection', () => {
  /** A file collected as `file:line` named it: only the tests declared at `lines` are selected. */
  // The tests are declared in this very file, which is what a line names, so
  // the collected module is this file under the `tests/` root.
  const THIS_FILE = fileURLToPath(import.meta.url);
  const TESTS_ROOT = path.dirname(path.dirname(THIS_FILE));
  const THIS_RELATIVE = 'unit/select.test.ts';
  async function collectionAtLines(body: () => void, pick: (declared: readonly number[]) => readonly number[]): Promise<Collection> {
    const registration = await collectModule(async () => body());
    const declared = registration.tests.map((entry) => entry.source!.line);
    const collected = collectFromRegistration(TESTS_ROOT, THIS_FILE, registration, true, pick(declared));
    return { files: [collected], tests: collected.tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
  }

  it('ignores a line that matches a test declared in a module the file imports', async () => {
    const registration = await collectModule(async () => {
      test('declared elsewhere', noop);
    });
    const line = registration.tests[0]!.source!.line;
    const importer = collectFromRegistration(TESTS_ROOT, path.join(TESTS_ROOT, 'unit', 'importer.e2e.ts'), registration, true, [line]);
    expect(importer.tests[0]!.selected).toBe(false);
    expect(importer.declaredLines).toEqual([]);
    const col: Collection = { files: [importer], tests: importer.tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    expect(() => select(col, config())).toThrow(
      `1 not declared at a line a positional named: unit/importer.e2e.ts:${line} names no test (the file declares no test itself)`,
    );
  });

  it('selects only the tests declared at the lines a file:line positional named', async () => {
    const col = await collectionAtLines(
      () => {
        test('first', noop);
        test('second', noop);
        test('third', noop);
      },
      (declared) => [declared[1]!],
    );
    const selection = select(col, config());
    expect(selection.pairs.map((pair) => [pair.test.title, pair.disposition])).toEqual([
      ['first', 'filtered'],
      ['second', 'run'],
      ['third', 'filtered'],
    ]);
    expect(selection.pairs[0]!.skip?.reason).toBe('not declared at a line a positional named');
  });

  it('names the file:line that found no test and the lines the file declares tests at', async () => {
    const col = await collectionAtLines(
      () => {
        test('first', noop);
        test('second', noop);
      },
      (declared) => [declared[0]! - 1, declared[1]! + 1],
    );
    const [first, second] = col.tests.map((entry) => entry.source!.line);
    expect(() => select(col, config())).toThrow(
      `2 tests were collected but none is runnable: 2 not declared at a line a positional named: ${THIS_RELATIVE}:${first! - 1}, ${THIS_RELATIVE}:${second! + 1} name no test (declared at lines ${first}, ${second}); pass --pass-with-no-tests to allow this`,
    );
  });

  it('pulls a serial group in whole when a file:line names one member', async () => {
    const col = await collectionAtLines(
      () => {
        test.describe('wizard', { serial: true }, () => {
          test('step 1', noop);
          test('step 2', noop);
        });
        test('other', noop);
      },
      (declared) => [declared[1]!],
    );
    expect(select(col, config()).pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'filtered']);
  });

  it('runs the setup a selected test needs from a file no positional named, and leaves that file\'s tests unselected', async () => {
    const col = await collectionOf(
      [
        {
          file: 'tests/auth.setup.e2e.ts',
          body: () => {
            test.setup('sign in', { sessions: ['admin'] }, async () => {});
            test('an ordinary neighbour of the setup', noop);
          },
        },
        {
          file: 'tests/dashboard.e2e.ts',
          body: () => {
            test('opens the dashboard', { session: 'admin' }, noop);
          },
        },
      ],
      ['tests/dashboard.e2e.ts'],
    );
    const selection = select(col, config());
    const byTitle = (title: string) => selection.pairs.find((pair) => pair.test.title === title)!;
    expect(byTitle('opens the dashboard').disposition).toBe('run');
    expect(byTitle('sign in').disposition).toBe('run');
    const neighbour = byTitle('an ordinary neighbour of the setup');
    expect(neighbour.disposition).toBe('filtered');
    expect(neighbour.skip).toEqual({ cause: 'filtered', reason: 'file not selected by a positional argument' });
  });

  it('ignores a .only in a file no positional named, locally and in CI', async () => {
    const modules = [
      { file: 'tests/a.e2e.ts', body: () => { test('a', noop); } },
      { file: 'tests/b.e2e.ts', body: () => { test.only('debug', noop); } },
    ];
    const local = select(await collectionOf(modules, ['tests/a.e2e.ts']), config());
    const byTitle = (title: string) => local.pairs.find((pair) => pair.test.title === title)!;
    expect(byTitle('a').disposition).toBe('run');
    expect(byTitle('debug').disposition).toBe('filtered');
    // CI rejects a focused test only when the run would have honoured it.
    const ci = config({}, { ...ENV, CI: '1' });
    const narrowed = await collectionOf(modules, ['tests/a.e2e.ts']);
    const whole = await collectionOf(modules);
    expect(() => select(narrowed, ci)).not.toThrow();
    expect(() => select(whole, ci)).toThrow(/\.only is rejected in CI/);
  });

  it('reports NO_TESTS when the only selected file holds nothing runnable', async () => {
    const col = await collectionOf(
      [
        { file: 'tests/a.e2e.ts', body: () => { test('a', noop); } },
        { file: 'tests/b.e2e.ts', body: () => { test.skip('b', noop); } },
      ],
      ['tests/b.e2e.ts'],
    );
    expect(() => select(col, config())).toThrow(/none is runnable: 1 file not selected by a positional argument, 1 skipped with test.skip/);
  });
});
