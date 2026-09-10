import { describe, expect, it } from 'vitest';
import { collectFromRegistration, type Collection } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { resolveOptions, select } from '../../src/collect/select.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';

const noop = async () => {};
const ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

async function collection(
  body: () => void,
  file = 'tests/a.e2e.ts',
  unmatchedPositionals: readonly string[] = [],
): Promise<Collection> {
  const registration = await collectModule(async () => body());
  const collected = collectFromRegistration('/root', `/root/${file}`, registration);
  // Positionals that matched nothing leave the discovered file unselected.
  const files = unmatchedPositionals.length === 0 ? [collected] : [];
  return { files, tests: files.flatMap((entry) => entry.tests), discovered: [file], nearMisses: [], unmatchedPositionals };
}

/** A collection whose globs matched nothing, with optional look-alike files. */
function emptyCollection(nearMisses: readonly string[] = []): Collection {
  return { files: [], tests: [], discovered: [], nearMisses, unmatchedPositionals: [] };
}

function config(raw: Parameters<typeof resolveConfig>[0] = {}, env: NodeJS.ProcessEnv = ENV) {
  return resolveConfig({ targets: [{ name: 'web', platform: 'web' }], ...raw }, { projectRoot: '/root', env });
}

/** `config()` with command-line overrides, the way `--agent` reaches selection. */
function configWith(raw: Parameters<typeof resolveConfig>[0], cli: NonNullable<Parameters<typeof resolveConfig>[1]['cli']>) {
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
    expect([...leaf.tags].toSorted()).toEqual(['inner', 'leaf', 'outer']);

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
        test('step 2', noop);
      });
    });
    const selection = select(col, config(), { tags: ['smoke'] });
    const step2 = selection.pairs.find((pair) => pair.test.title === 'step 2')!;
    expect(step2.disposition).toBe('run');
    expect(step2.skip).toBeUndefined();
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
      "tests/a.e2e.ts registered no tests; import { test } from '@e2edev/e2e' (or from the engine package) and call test() at the top level of the module",
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
      '2 tests were collected but none is runnable: 2 carry none of the tags billing; pass --pass-with-no-tests to allow this',
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
