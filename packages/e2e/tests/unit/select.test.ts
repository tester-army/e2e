import { describe, expect, it } from 'vitest';
import { collectFromRegistration, type Collection } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { resolveOptions, select } from '../../src/collect/select.ts';
import { resolveConfig } from '../../src/config/resolve.ts';

const noop = async () => {};
const ENV = { APP_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv;

async function collection(body: () => void, file = 'tests/a.e2e.ts'): Promise<Collection> {
  const registration = await collectModule(async () => body());
  const collected = collectFromRegistration('/root', `/root/${file}`, registration);
  return { files: [collected], tests: collected.tests };
}

function config(raw: Parameters<typeof resolveConfig>[0] = {}, env: NodeJS.ProcessEnv = ENV) {
  return resolveConfig(raw, { projectRoot: '/root', env });
}

describe('resolveOptions', () => {
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
    expect([...leaf.tags].sort()).toEqual(['inner', 'leaf', 'outer']);

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
    const selection = select(col, config());
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
    expect(() => select(col, config())).toThrow(/zero runnable/);
    expect(() => select(col, config(), {}, { passWithNoTests: true })).not.toThrow();
  });

  it('rejects unknown target IDs', async () => {
    const col = await collection(() => {
      test('x', noop);
    });
    expect(() => select(col, config(), { targetIds: ['nope'] })).toThrow(/unknown target/i);
  });
});
