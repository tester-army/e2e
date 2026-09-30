import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareSamples } from './compare.ts';
import { renderMarkdown } from './markdown.ts';
import { sampleFromReport, type ReportDocument } from './sample.ts';

interface StepSpec {
  api: string;
  durationMs: number;
  status?: string;
  cache?: string;
  nodes?: number;
}

/** A report with one test per entry of `tests`, each one attempt of the given steps. */
function report(tests: Record<string, StepSpec[]>, status = 'passed'): ReportDocument {
  return {
    run: {
      exitCode: status === 'passed' ? 0 : 1,
      serialGroups: [],
      usage: { modelTokens: 0 },
      results: Object.entries(tests).map(([title, steps]) => ({
        file: 'tests/a.e2e.ts',
        titlePath: [title],
        targetId: 'web',
        agent: 'default',
        repeat: 0,
        status,
        attempts: [{
          status,
          durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
          steps: steps.map((step) => ({
            kind: step.api.split('.')[0]!,
            api: step.api,
            label: title,
            status: step.status ?? 'passed',
            durationMs: step.durationMs,
            ...(step.cache === undefined ? {} : { cache: { mode: step.cache } }),
            events: step.nodes === undefined ? [] : [{ kind: 'observation', durationMs: step.durationMs / 2, count: step.nodes, bytes: 10 }],
          })),
        }],
      })),
    },
  };
}

const limits = { threshold: 0.05, floorMs: 10 };

const header = {
  base: { ref: 'merge base with origin/main', sha: 'a'.repeat(40) },
  head: { sha: 'b'.repeat(40), dirty: true },
  suite: 'apps/web-benchmark',
  command: 'e2e run --workers 1',
  threshold: 0.05,
  floorMs: 10,
  stop: 'resolved after 6 pairs',
  machine: 'test machine',
  suiteDiffers: false,
};

describe('compareSamples', () => {
  it('times a faster head and reports no behavior change', () => {
    const base = Array.from({ length: 6 }, (_, index) =>
      sampleFromReport(report({ one: [{ api: 'agent.act', durationMs: 1000 + index, cache: 'self-finalized', nodes: 5 }] }), 2000));
    const head = Array.from({ length: 6 }, (_, index) =>
      sampleFromReport(report({ one: [{ api: 'agent.act', durationMs: 500 + index, cache: 'self-finalized', nodes: 5 }] }), 1500));
    const comparison = compareSamples(base, head, limits);
    assert.deepEqual(comparison.changes, []);
    assert.deepEqual(comparison.counters, []);
    const suite = comparison.timings.find((row) => row.name === 'suite (sum of attempts)')!;
    assert.equal(suite.delta.verdict, 'faster');
    assert.equal(comparison.cases.length, 1);
    const markdown = renderMarkdown(header, comparison);
    assert.match(markdown, /Every test ran the same steps/);
    assert.match(markdown, /\| suite \(sum of attempts\) \| 1\.00 s .* \| faster \|/);
  });

  it('reads a doubled millisecond step as the same under the floor', () => {
    const base = Array.from({ length: 6 }, () => sampleFromReport(report({ one: [{ api: 'browser.keyboard.press', durationMs: 1 }] }), 100));
    const head = Array.from({ length: 6 }, () => sampleFromReport(report({ one: [{ api: 'browser.keyboard.press', durationMs: 2 }] }), 100));
    const step = compareSamples(base, head, limits).timings.find((row) => row.name === 'step browser.keyboard.press')!;
    assert.equal(step.delta.estimate, 1);
    assert.equal(step.delta.verdict, 'same');
    assert.equal(step.belowFloor, true);
  });

  it('lists a changed step sequence and a moved counter, and leaves the test out of the timing rows', () => {
    const base = [0, 1].map(() => sampleFromReport(report({ one: [{ api: 'agent.act', durationMs: 900, cache: 'self-finalized', nodes: 5 }] }), 1000));
    const head = [0, 1].map(() => sampleFromReport(report({ one: [{ api: 'agent.act', durationMs: 900, cache: 'missed', nodes: 7 }] }), 1000));
    const comparison = compareSamples(base, head, limits);
    assert.equal(comparison.changes.length, 1);
    assert.equal(comparison.changes[0]!.kind, 'changed');
    assert.equal(comparison.casesCompared, 0);
    assert.deepEqual(comparison.counters.map((row) => row.name), ['cache missed', 'cache self-finalized', 'observed nodes']);
    const markdown = renderMarkdown(header, comparison);
    assert.match(markdown, /- agent agent\.act "one" passed cache:self-finalized/);
    assert.match(markdown, /\+ agent agent\.act "one" passed cache:missed/);
  });

  it('leaves a test whose behavior changed out of the suite and phase totals', () => {
    const base = Array.from({ length: 6 }, (_, index) => sampleFromReport(report({
      stable: [{ api: 'agent.act', durationMs: 1000 + index, cache: 'self-finalized', nodes: 5 }],
      moved: [{ api: 'agent.act', durationMs: 4000 + index, cache: 'missed', nodes: 5 }],
    }), 6000));
    const head = Array.from({ length: 6 }, (_, index) => sampleFromReport(report({
      stable: [{ api: 'agent.act', durationMs: 1000 + index, cache: 'self-finalized', nodes: 5 }],
      moved: [{ api: 'agent.act', durationMs: 400 + index, cache: 'self-finalized', nodes: 5 }],
    }), 3000));
    const comparison = compareSamples(base, head, limits);
    assert.deepEqual(comparison.changes.map((change) => change.kind), ['changed']);
    const row = (name: string) => comparison.timings.find((entry) => entry.name === name)!;
    assert.equal(row('suite (sum of attempts)').delta.verdict, 'same');
    assert.equal(row('suite (sum of attempts)').base.median, 1002.5);
    assert.equal(row('step agent.act').delta.verdict, 'same');
    assert.equal(row('wall (process)').delta.verdict, 'faster');
    assert.match(renderMarkdown(header, comparison), /covers the 1 tests whose behavior matched/);
  });

  it('keeps a test skipped before it started, and calls a test missing from some runs of one build unstable', () => {
    const skipped: ReportDocument = {
      run: {
        exitCode: 0,
        serialGroups: [],
        usage: { modelTokens: 0 },
        results: [{ file: 'tests/a.e2e.ts', titlePath: ['later'], targetId: 'web', agent: 'default', repeat: 0, status: 'skipped', skip: { cause: 'failure-limit' }, attempts: [] }],
      },
    };
    const withSkip = sampleFromReport(skipped, 100);
    assert.equal(withSkip.cases.get('tests/a.e2e.ts › later (web)')?.signature, 'status skipped (failure-limit)\nattempts 0');
    const present = sampleFromReport(report({ one: [{ api: 'app.open', durationMs: 10 }] }), 100);
    const absent = sampleFromReport(report({}), 100);
    const changes = compareSamples([present, absent], [present, present], limits).changes;
    assert.deepEqual(changes, [{ kind: 'unstable', key: 'tests/a.e2e.ts › one (web)', side: 'base', variants: 2 }]);
  });

  it('flags a test whose steps vary between runs of one build, and tests that only one side has', () => {
    const base = [
      sampleFromReport(report({ one: [{ api: 'app.open', durationMs: 10 }], gone: [{ api: 'app.open', durationMs: 10 }] }), 100),
      sampleFromReport(report({ one: [{ api: 'app.open', durationMs: 10, status: 'failed' }], gone: [{ api: 'app.open', durationMs: 10 }] }), 100),
    ];
    const head = [0, 1].map(() => sampleFromReport(report({ one: [{ api: 'app.open', durationMs: 10 }], fresh: [{ api: 'app.open', durationMs: 10 }] }), 100));
    const kinds = compareSamples(base, head, limits).changes.map((change) => `${change.kind} ${change.key}`);
    assert.deepEqual(kinds, [
      'added tests/a.e2e.ts › fresh (web)',
      'removed tests/a.e2e.ts › gone (web)',
      'unstable tests/a.e2e.ts › one (web)',
    ]);
  });
});
