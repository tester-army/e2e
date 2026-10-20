/**
 * `cigeSuite` and the `cige()` reporter through the real runner: a project
 * of CIGE files on an in-memory engine and a scripted executor, no model and
 * no browser. Each case lands in one branch of the CIGE workflow, and its run
 * summary must say so.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'e2e/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cige, type CigeRunSummary } from '../src/reporter.ts';

// Inside the package, so `e2e` and `@e2e-dev/cige` resolve the way they do for a user.
const PROJECT = fileURLToPath(new URL('./tmp-projects/suite/', import.meta.url));

const CONFIG = `import type { E2EConfig, StepExecutor } from 'e2e';
import { defineEngine } from 'e2e/engine';
import { cige } from '@e2e-dev/cige';

const root = { ref: { id: 'root', revision: '' }, role: 'window' as const, children: [] };

const engine = defineEngine({
  name: 'memory',
  version: '1.0.0',
  spiVersion: 1,
  platform: 'test',
  async observe() {
    return { location: 'memory://app', root, viewport: { width: 800, height: 600 } };
  },
  async locate() {
    return [];
  },
});

/** Passes every step but those whose words say otherwise. */
const scripted: StepExecutor = {
  name: 'scripted',
  version: '1',
  cache: 'off',
  async runStep(ctx) {
    const text = ctx.step.instruction;
    if (text.startsWith('refund')) {
      await ctx.budgets.runTool({ name: 'refund', mutates: true }, async () => 'refunded');
      return { status: 'passed', summary: 'refunded the order' };
    }
    if (text.startsWith('press the old')) {
      return { status: 'failed', errorCode: 'LOCATOR_NOT_FOUND', summary: 'there is no such button any more' };
    }
    if (ctx.step.kind === 'assert' && text.includes('discount')) {
      return { status: 'failed', summary: 'the total shows no discount' };
    }
    return { status: 'passed', summary: 'done' };
  },
};

export default {
  projectId: 'cige-suite-test',
  targets: [{ name: 'memory', engine, app: { url: 'http://127.0.0.1:4599' } }],
  workers: 1,
  retries: 0,
  agents: { default: { executor: scripted } },
  reporters: [cige({ cases: ['cases/*.cige.json', 'serial-cases/*.cige.json'], build: 'test-build' })],
} satisfies E2EConfig;
`;

const SUITE = `import { AgentError } from 'e2e';
import { cigeSuite } from '@e2e-dev/cige';

cigeSuite('cases/*.cige.json', {
  root: new URL('..', import.meta.url),
  hooks: {
    orderExists: () => true,
    orderMissing: () => false,
    environmentDown: () => {
      throw new AgentError('ENVIRONMENT_UNAVAILABLE', 'the staging API is down');
    },
  },
});
`;

const CASES: Record<string, object> = {
  pass: {
    id: 'pass',
    Context: { system: 'Shop', specRef: 'specs/checkout.md', buildRef: 'CHANGELOG.md' },
    Intent: { statement: 'A shopper can place an order', evidence: [{ id: 'order-record', hook: 'orderExists' }] },
    Guardrails: ['Use only the test card'],
    Execution: [{ id: 'e1', step: 'add one item to the cart' }, { id: 'e2', verify: 'the cart shows one item' }, { id: 'e3', step: 'pay with the test card' }],
  },
  guardrail: {
    id: 'guardrail',
    Context: {},
    Intent: 'A support agent can view an order',
    Guardrails: [{ id: 'no-refund', rule: 'Never refund an order', deny: { actions: ['tool:refund'] } }],
    Execution: [{ id: 'e1', step: 'refund the order to see its details' }],
  },
  stale: {
    id: 'stale',
    Context: {},
    Intent: 'A shopper can open checkout',
    Execution: [{ id: 'e1', step: 'add one item to the cart' }, { id: 'e2', step: 'press the old Checkout button' }],
  },
  defect: {
    id: 'defect',
    Context: {},
    Intent: 'The total applies the discount',
    Execution: [{ id: 'e1', step: 'apply the code SAVE10' }],
  },
  evidence: {
    id: 'evidence',
    Context: {},
    Intent: { statement: 'An order is persisted', judge: false, evidence: [{ id: 'order-record', hook: 'orderMissing' }] },
    Execution: [{ id: 'e1', step: 'place an order' }],
  },
  infrastructure: {
    id: 'infrastructure',
    Context: { preconditions: [{ hook: 'environmentDown' }] },
    Intent: 'A shopper can browse the catalog',
    Execution: [{ id: 'e1', step: 'open the catalog' }],
  },
};

const SERIAL_SUITE = `import { describe } from 'e2e';
import { cigeSuite } from '@e2e-dev/cige';

describe('checkout flow', { serial: true }, () => {
  cigeSuite('serial-cases/*.cige.json', { root: new URL('..', import.meta.url) });
});
`;

const SERIAL_CASES: Record<string, object> = {
  'a-cart': { id: 'serial-cart', Context: {}, Intent: 'A shopper can fill the cart', Execution: [{ id: 'e1', step: 'add one item to the cart' }] },
  'b-checkout': { id: 'serial-checkout', Context: {}, Intent: 'A shopper can reach checkout', Execution: [{ id: 'e1', step: 'press the old Checkout button' }] },
};

let summaries: Record<string, CigeRunSummary>;
let outcome: Awaited<ReturnType<typeof run>>;
let exitCode: number;
let tags: Record<string, readonly string[]>;
let written: string[];

beforeAll(async () => {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(path.join(PROJECT, 'cases'), { recursive: true });
  mkdirSync(path.join(PROJECT, 'tests'), { recursive: true });
  mkdirSync(path.join(PROJECT, 'serial-cases'), { recursive: true });
  writeFileSync(path.join(PROJECT, 'tests', 'serial.e2e.ts'), SERIAL_SUITE);
  for (const [name, testCase] of Object.entries(SERIAL_CASES)) {
    writeFileSync(path.join(PROJECT, 'serial-cases', `${name}.cige.json`), JSON.stringify(testCase, null, 2));
  }
  mkdirSync(path.join(PROJECT, 'tests'), { recursive: true });
  writeFileSync(path.join(PROJECT, 'e2e.config.ts'), CONFIG);
  writeFileSync(path.join(PROJECT, 'tests', 'cige.e2e.ts'), SUITE);
  for (const [name, testCase] of Object.entries(CASES)) {
    writeFileSync(path.join(PROJECT, 'cases', `${name}.cige.json`), JSON.stringify(testCase, null, 2));
  }
  // Left by an earlier run: the old summary must go, the unrelated file must stay.
  mkdirSync(path.join(PROJECT, '.e2e', 'cige'), { recursive: true });
  writeFileSync(path.join(PROJECT, '.e2e', 'cige', 'retired.run-summary.json'), '{}');
  writeFileSync(path.join(PROJECT, '.e2e', 'cige', 'notes.txt'), 'keep me');
  outcome = await run({ cwd: PROJECT });
  exitCode = outcome.exitCode;
  tags = Object.fromEntries(outcome.report.run.results.map((result) => [result.titlePath.at(-1) ?? '', result.tags]));
  const dir = path.join(PROJECT, '.e2e', 'cige');
  written = readdirSync(dir).toSorted();
  summaries = Object.fromEntries(
    readdirSync(dir).filter((file) => file.endsWith('.run-summary.json')).map((file) => {
      const summary = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as CigeRunSummary;
      return [summary.testId, summary];
    }),
  );
}, 120_000);

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
});

describe('cigeSuite through the runner', () => {
  it('registers one tagged test per case, titled by its Intent', () => {
    expect(exitCode).not.toBe(0);
    expect(tags['A shopper can place an order']).toEqual(['cige', 'cige:pass']);
    expect(Object.keys(summaries).toSorted()).toEqual([
      'defect',
      'evidence',
      'guardrail',
      'infrastructure',
      'pass',
      'serial-cart',
      'serial-checkout',
      'stale',
    ]);
  });

  it('replaces the summaries of an earlier run and leaves other files alone', () => {
    expect(written).not.toContain('retired.run-summary.json');
    expect(written).toContain('notes.txt');
  });

  it('summarizes a pass with its pointers and no failure type', () => {
    expect(summaries.pass).toMatchObject({
      result: 'pass',
      intent: 'A shopper can place an order',
      build: 'test-build',
      specRef: 'specs/checkout.md',
      buildRef: 'CHANGELOG.md',
      case: 'cases/pass.cige.json',
      target: 'memory',
      agent: 'default',
      attempts: 1,
      classification: { source: '@e2e-dev/cige', confidence: 'heuristic', signals: ['status:passed'] },
      evidence: { report: '.e2e/report.json' },
    });
    expect(summaries.pass).not.toHaveProperty('failureType');
  });

  it('names the guardrail an action broke and leaves the type to the classifier', () => {
    expect(summaries.guardrail).toMatchObject({
      result: 'fail',
      failedStep: 'e1',
      classification: { phase: 'execution', errorCode: 'POLICY_DENIED' },
    });
    expect(summaries.guardrail?.classification.signals).toContain('guardrail-violation:no-refund');
    expect(summaries.guardrail).not.toHaveProperty('failureType');
  });

  it('flags a path that no longer exists as outdated test logic', () => {
    expect(summaries.stale).toMatchObject({ result: 'fail', failedStep: 'e2', failureType: 'outdated-test-logic', classification: { errorCode: 'LOCATOR_NOT_FOUND' } });
  });

  it('flags an Intent the screen contradicts as a product defect', () => {
    expect(summaries.defect).toMatchObject({ result: 'fail', failedStep: 'intent', failureType: 'product-defect', classification: { phase: 'intent' } });
  });

  it('fails a case whose evidence does not hold, even though every step passed', () => {
    expect(summaries.evidence).toMatchObject({ result: 'fail', failedStep: 'order-record', failureType: 'product-defect', classification: { phase: 'evidence' } });
  });

  it('flags a precondition the environment cannot meet as infrastructure', () => {
    expect(summaries.infrastructure).toMatchObject({
      result: 'fail',
      failureType: 'infrastructure',
      classification: { phase: 'precondition', errorCode: 'ENVIRONMENT_UNAVAILABLE' },
    });
  });

  it('reads the steps of a serial member from its group', () => {
    expect(summaries['serial-cart']).toMatchObject({ result: 'pass', attempts: 1 });
    expect(summaries['serial-checkout']).toMatchObject({ result: 'fail', failedStep: 'e1', failureType: 'outdated-test-logic' });
    expect(summaries['serial-checkout']?.attempts).toBeGreaterThan(0);
  });
});

describe('the reporter on a later run', () => {
  const dir = (): string => path.join(PROJECT, '.e2e', 'cige');
  function finished(report: typeof outcome.report, lastRun?: typeof outcome.report): Parameters<NonNullable<ReturnType<typeof cige>['onRunFinished']>>[0] {
    return {
      report,
      status: outcome.status,
      exitCode: outcome.exitCode,
      projectRoot: PROJECT,
      reportPath: outcome.reportPath,
      artifactsRoot: path.join(PROJECT, '.e2e', 'results'),
      aiTracePath: undefined,
      traces: new Map(),
      ...(lastRun === undefined ? {} : { lastRun }),
    };
  }
  const reporter = (): ReturnType<typeof cige> => cige({ cases: ['cases/*.cige.json', 'serial-cases/*.cige.json'] });

  it('keeps the summaries of cases a --last-failed rerun did not run', async () => {
    const only = (id: string) => outcome.report.run.results.filter((result) => result.tags.includes(`cige:${id}`));
    const rerun = { ...outcome.report, run: { ...outcome.report.run, results: only('stale') } };
    await reporter().onRunFinished!(finished(rerun, outcome.report), new AbortController().signal);
    expect(readdirSync(dir())).toContain('pass.run-summary.json');
    expect(readdirSync(dir())).toContain('stale.run-summary.json');
  });

  it('writes a summary for a failure the rerun carried without running it', async () => {
    rmSync(path.join(dir(), 'defect.run-summary.json'));
    const carried = outcome.report.run.results.filter((result) => result.tags.includes('cige:defect'));
    const rerun = { ...outcome.report, run: { ...outcome.report.run, results: [], carried: { results: carried, serialGroups: [], errors: [] } } };
    await reporter().onRunFinished!(finished(rerun, outcome.report), new AbortController().signal);
    const summary = JSON.parse(readFileSync(path.join(dir(), 'defect.run-summary.json'), 'utf8')) as CigeRunSummary;
    expect(summary).toMatchObject({ result: 'fail', failureType: 'product-defect' });
    expect(summary.classification.signals).toContain('carried-from-earlier-run');
  });

  it('clears old summaries when a run has no CIGE result to write', async () => {
    const none = { ...outcome.report, run: { ...outcome.report.run, results: [] } };
    await reporter().onRunFinished!(finished(none), new AbortController().signal);
    expect(readdirSync(dir()).filter((file) => file.endsWith('.run-summary.json'))).toEqual([]);
    expect(readdirSync(dir())).toContain('notes.txt');
  });
});
