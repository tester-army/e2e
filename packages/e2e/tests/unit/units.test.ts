import { describe, expect, it } from 'vitest';
import type { CollectedFile, CollectedTest, Collection } from '../../src/collect/collect.ts';
import type {
  ResolvedTestOptions,
  Selection,
  TestTargetPair,
} from '../../src/collect/select.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import { buildWorkPlans, nonRunResult, unstartedResult } from '../../src/run/units.ts';
import { decodeResult, encodeResult } from '../../src/run/worker/protocol.ts';
import type { ResultRecord } from '../../src/run/records.ts';

const target: ResolvedTarget = {
  name: 'web',
  index: 0,
  platform: 'web',
  backend: undefined,
};

function makeTest(
  file: string,
  title: string,
  declarationIndex: number,
  overrides: Partial<CollectedTest> = {},
): CollectedTest {
  return {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex,
    options: {},
    sessions: [],
    fn: () => undefined,
    group: undefined,
    mode: 'normal',
    source: undefined,
    file,
    id: `test::${file}::${title}`,
    serialRoot: undefined,
    serialId: undefined,
    ...overrides,
  };
}

const defaultOptions: ResolvedTestOptions = {
  timeout: 30_000,
  retries: 0,
  tags: [],
  platforms: undefined,
  requires: [],
  session: undefined,
  agentContext: undefined,
  skipReason: undefined,
  serial: false,
};

function makePair(test: CollectedTest, overrides: Partial<TestTargetPair> = {}): TestTargetPair {
  return { test, target, options: defaultOptions, disposition: 'run', skip: undefined, ...overrides };
}

function makeFile(file: string, tests: CollectedTest[]): CollectedFile {
  return {
    file,
    absolutePath: `/project/${file}`,
    registration: { tests: [], hooks: [] },
    tests,
  };
}

describe('buildWorkPlans', () => {
  it('groups runnable ordinary pairs into per-file units and setups into single-pair units', () => {
    const setup = makeTest('tests/auth.setup.e2e.ts', 'login', 0, {
      kind: 'setup',
      sessions: ['user'],
    });
    const a1 = makeTest('tests/a.e2e.ts', 'a one', 0);
    const a2 = makeTest('tests/a.e2e.ts', 'a two', 1);
    const b1 = makeTest('tests/b.e2e.ts', 'b one', 0);
    const skipped = makeTest('tests/b.e2e.ts', 'b skipped', 1);

    const pairs = [
      makePair(setup),
      makePair(a1),
      makePair(a2),
      makePair(b1),
      makePair(skipped, {
        disposition: 'skip',
        skip: { cause: 'explicit', reason: 'skipped' },
      }),
    ];
    const selection: Selection = { pairs, perTarget: [{ target, pairs }] };
    const collection: Collection = {
      files: [
        makeFile('tests/a.e2e.ts', [a1, a2]),
        makeFile('tests/auth.setup.e2e.ts', [setup]),
        makeFile('tests/b.e2e.ts', [b1, skipped]),
      ],
      tests: [a1, a2, setup, b1, skipped],
    };

    const plans = buildWorkPlans(selection, collection, '/project');
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.setupUnits).toHaveLength(1);
    expect(plan.setupUnits[0]!.kind).toBe('setup');
    expect(plan.setupUnits[0]!.pairs.map((pair) => pair.test.title)).toEqual(['login']);
    expect(plan.fileUnits.map((unit) => unit.file)).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
    expect(plan.fileUnits[0]!.pairs.map((pair) => pair.test.title)).toEqual(['a one', 'a two']);
    expect(plan.fileUnits[1]!.pairs.map((pair) => pair.test.title)).toEqual(['b one']);
    expect(plan.immediate.map((pair) => pair.test.title)).toEqual(['b skipped']);
  });

  it('emits no file unit when a file has no runnable pairs', () => {
    const only = makeTest('tests/a.e2e.ts', 'filtered', 0);
    const pairs = [
      makePair(only, { disposition: 'filtered', skip: { cause: 'filtered', reason: 'tags' } }),
    ];
    const selection: Selection = { pairs, perTarget: [{ target, pairs }] };
    const collection: Collection = {
      files: [makeFile('tests/a.e2e.ts', [only])],
      tests: [only],
    };
    const plans = buildWorkPlans(selection, collection, '/project');
    expect(plans[0]!.fileUnits).toHaveLength(0);
    expect(plans[0]!.immediate).toHaveLength(1);
  });
});

describe('result helpers', () => {
  it('nonRunResult marks skip pairs selected and filtered pairs unselected', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const skipPair = makePair(test, {
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'skipped' },
    });
    const filteredPair = makePair(test, { disposition: 'filtered', skip: undefined });
    expect(nonRunResult(skipPair)).toMatchObject({ status: 'skipped', selected: true });
    expect(nonRunResult(filteredPair)).toMatchObject({
      status: 'skipped',
      selected: false,
      skip: { cause: 'filtered' },
    });
  });

  it('unstartedResult keeps the pair identity and provided skip info', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const record = unstartedResult(makePair(test), {
      cause: 'infrastructure-unavailable',
      reason: 'worker crashed',
    });
    expect(record.status).toBe('skipped');
    expect(record.selected).toBe(true);
    expect(record.skip?.reason).toBe('worker crashed');
  });
});

describe('wire protocol', () => {
  it('round-trips a result record, replacing the target', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const record: ResultRecord = {
      test,
      target,
      status: 'passed',
      selected: true,
      attempts: [],
    };
    const wire = JSON.parse(JSON.stringify(encodeResult(record)));
    expect(wire.target).toBeUndefined();
    const decoded = decodeResult(wire, target);
    expect(decoded.target).toBe(target);
    expect(decoded.test.id).toBe(test.id);
    expect(decoded.status).toBe('passed');
  });

  it('carries no test function across the wire', () => {
    const record = nonRunResult({
      test: makeTest('tests/a.e2e.ts', 'x', 0),
      target,
      options: defaultOptions,
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'skipped' },
    });
    expect('fn' in record.test).toBe(false);
    expect(JSON.parse(JSON.stringify(encodeResult(record))).test.id).toBe(record.test.id);
  });
});
