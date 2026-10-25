/**
 * `cigeSuite` and the `cige()` reporter through the real runner: a project
 * of CIGE files on an in-memory engine and a scripted executor, no model and
 * no browser. Each case lands in one branch of the CIGE workflow, and its run
 * summary must say so.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'e2e/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cige, type CigeRunSummary } from '../src/reporter.ts';

// Inside the package, so `e2e` and `@e2e-dev/cige` resolve the way they do for a user.
const PROJECT = fileURLToPath(new URL('./tmp-projects/suite/', import.meta.url));

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const CONFIG = `import type { E2EConfig, StepExecutor } from 'e2e';
import { defineEngine } from 'e2e/engine';
import { cige } from '@e2e-dev/cige';
import cigeConfig from './cige.config.ts';

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
    if (text.startsWith('drag the card')) {
      return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'this engine has no drag verb' };
    }
    if (text.startsWith('open the seeded order')) {
      return { status: 'blocked', errorCode: 'SEED_DATA_MISSING', summary: 'there is no seeded order to open' };
    }
    if (text.startsWith('act before opening')) {
      return { status: 'blocked', errorCode: 'APP_NOT_OPEN', summary: 'no app is open yet' };
    }
    if (text.startsWith('open the local file')) {
      return { status: 'failed', errorCode: 'POLICY_DENIED', summary: 'navigation to file:///etc/hosts is denied' };
    }
    if (text.startsWith('open the Billing tab')) {
      return { status: 'failed', errorCode: 'ASSERTION_FAILED', summary: 'the wizard has no Billing tab' };
    }
    if (text.startsWith('delete the todo')) {
      return { status: 'failed', errorCode: 'POLICY_DENIED', summary: 'deleting is prohibited by the no-delete guardrail; I did not delete it' };
    }
    if (text.startsWith('refund')) {
      await ctx.budgets.runTool({ name: 'refund', mutates: true }, async () => 'refunded');
      return { status: 'passed', summary: 'refunded the order' };
    }
    if (text.startsWith('press the old') || ctx.step.params?.method === 'voucher') {
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
  reporters: [cige({ ...cigeConfig, cases: ['cases/*.cige.json', 'serial-cases/*.cige.json'] })],
} satisfies E2EConfig;
`;

// One config for the suite, the reporter, and the e2e-cige command, the way the docs set it up.
const CIGE_CONFIG = `import { writeFileSync } from 'node:fs';
import { AgentError } from 'e2e';
import { defineCige } from '@e2e-dev/cige';

export default defineCige({
  cases: 'cases/*.cige.json',
  root: new URL('.', import.meta.url),
  build: 'test-build',
  hooks: {
    orderExists: () => true,
    orderMissing: () => false,
    environmentDown: () => {
      throw new AgentError('ENVIRONMENT_UNAVAILABLE', 'the staging API is down');
    },
  },
  environments: {
    memory: { config: 'e2e.config.ts', reset: () => writeFileSync(new URL('./reset-ran.txt', import.meta.url), 'memory') },
  },
  plugins: [
    {
      name: 'orders',
      steps: {
        'order-api': ({ step }) => {
          if (step.with.status !== 200) throw new Error(\`the orders API answered \${String(step.with.status)}\`);
        },
      },
      classify: ({ testCase, classification }) =>
        classification.result === 'fail' && testCase.extensions?.['x-ticket'] !== undefined ? { signals: ['ticketed'] } : undefined,
      summarize: ({ testCase }) => ({ owner: testCase.extensions?.['x-owner'] ?? null }),
    },
    // Repeats a signal the result already has: a no-op, which must not count as an adjustment.
    { name: 'echo', classify: ({ classification }) => ({ signals: classification.signals.slice(0, 1) }) },
  ],
  refs: {
    build: ({ build, pointer }) => ({ text: \`Release notes for \${build} from \${pointer}\` }),
    spec: () => {
      throw new Error('the wiki is down');
    },
  },
});
`;

const SUITE = `import { cigeSuite } from '@e2e-dev/cige';
import config from '../cige.config.ts';

cigeSuite(config);
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
    Context: { environment: 'memory', buildRef: 'releases/{build}.md' },
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
  variants: {
    id: 'variants',
    Context: {},
    Intent: 'A shopper can pay by {method}',
    Execution: [{ id: 'e1', step: 'pay by {method}' }],
    Variants: [
      { id: 'card', params: { method: 'card' } },
      { id: 'voucher', params: { method: 'voucher' } },
    ],
  },
  blocked: {
    id: 'blocked',
    Context: {},
    Intent: 'A user can move a card to Done',
    Execution: [{ id: 'e1', step: 'drag the card to Done' }],
  },
  unseeded: {
    id: 'unseeded',
    Context: {},
    Intent: 'A shopper can open their order',
    Execution: [{ id: 'e1', step: 'open the seeded order' }],
  },
  'blocked-setup': {
    id: 'blocked-setup',
    Context: {},
    Intent: 'A visitor can see the home page',
    Execution: [{ id: 'e1', step: 'act before opening the app' }],
  },
  denied: {
    id: 'denied',
    Context: {},
    Intent: 'A visitor can read the hosts file',
    Execution: [{ id: 'e1', step: 'open the local file /etc/hosts' }],
  },
  unreachable: {
    id: 'unreachable',
    Context: {},
    Intent: 'A visitor can pick monthly billing',
    Execution: [{ id: 'e1', step: 'open the Billing tab and pick monthly billing' }],
  },
  refused: {
    id: 'refused',
    Context: {},
    Intent: 'A user can clear a finished todo',
    Guardrails: [{ id: 'no-delete', rule: 'Never delete a todo' }],
    Execution: [{ id: 'e1', step: 'delete the todo "Old task"' }],
  },
  api: {
    id: 'api',
    'x-ticket': 'SHOP-1',
    'x-owner': 'checkout-team',
    Context: {},
    Intent: 'The orders API answers',
    Execution: [
      { id: 'e1', step: 'open the orders page' },
      { id: 'e2', use: 'order-api', with: { status: 500 } },
    ],
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
  writeFileSync(path.join(PROJECT, 'cige.config.ts'), CIGE_CONFIG);
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
      return [summary.variant === undefined ? summary.testId : `${summary.testId}.${summary.variant}`, summary];
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
      'api',
      'blocked',
      'blocked-setup',
      'defect',
      'denied',
      'evidence',
      'guardrail',
      'infrastructure',
      'pass',
      'refused',
      'serial-cart',
      'serial-checkout',
      'stale',
      'unreachable',
      'unseeded',
      'variants.card',
      'variants.voucher',
    ]);
  });

  it('runs a case once per variant, each tagged and titled apart', () => {
    expect(tags['A shopper can pay by card [card]']).toEqual(['cige', 'cige:variants', 'cige:variants/card']);
    expect(tags['A shopper can pay by voucher [voucher]']).toEqual(['cige', 'cige:variants', 'cige:variants/voucher']);
    expect(summaries['variants.card']).toMatchObject({ testId: 'variants', variant: 'card', result: 'pass', intent: 'A shopper can pay by card' });
    expect(summaries['variants.voucher']).toMatchObject({ variant: 'voucher', result: 'fail', failedStep: 'e1', failureType: 'outdated-test-logic' });
    expect(written).toContain('variants.voucher.run-summary.json');
  });

  it('classifies from the runner categories and step status, not from a copy of its code list', () => {
    // AUTOMATION_UNSUPPORTED is named nowhere in the classifier: the blocked step says it.
    expect(summaries.blocked).toMatchObject({ result: 'fail', failedStep: 'e1', classification: { errorCode: 'AUTOMATION_UNSUPPORTED' } });
    expect(summaries.blocked).not.toHaveProperty('failureType');
    expect(summaries.blocked?.classification.signals).toContain('automation-limit');
    // SEED_DATA_MISSING is named nowhere either: its configuration class makes it infrastructure.
    expect(summaries.unseeded).toMatchObject({ result: 'fail', failureType: 'infrastructure', classification: { errorCode: 'SEED_DATA_MISSING' } });
    // A blocked step that is a setup gap, not a limit of the automation.
    expect(summaries['blocked-setup']).toMatchObject({ result: 'fail', classification: { errorCode: 'APP_NOT_OPEN' } });
    expect(summaries['blocked-setup']).not.toHaveProperty('failureType');
    expect(summaries['blocked-setup']?.classification.signals).not.toContain('automation-limit');
    // A configuration-class refusal that is no guardrail's and no environment's.
    expect(summaries.denied).toMatchObject({ result: 'fail', classification: { errorCode: 'POLICY_DENIED' } });
    expect(summaries.denied).not.toHaveProperty('failureType');
    expect(summaries.denied?.classification.signals.some((signal) => signal.startsWith('guardrail-'))).toBe(false);
  });

  it('leaves an act goal the agent could not reach untyped, unlike a failed check', () => {
    expect(summaries.unreachable).toMatchObject({ result: 'fail', failedStep: 'e1', classification: { errorCode: 'ASSERTION_FAILED' } });
    expect(summaries.unreachable).not.toHaveProperty('failureType');
    expect(summaries.unreachable?.classification.signals).toContain('goal-unreachable');
  });

  it('names the guardrail an agent refused to break before acting', () => {
    expect(summaries.refused).toMatchObject({ result: 'fail', failedStep: 'e1', classification: { errorCode: 'POLICY_DENIED' } });
    expect(summaries.refused).not.toHaveProperty('failureType');
    expect(summaries.refused?.classification.signals).toContain('guardrail-refused:no-delete');
  });

  it('runs a plugin step and carries x- keys and plugin fields into the summary', () => {
    expect(summaries.api).toMatchObject({
      result: 'fail',
      failedStep: 'e2',
      classification: { phase: 'execution', errorCode: 'ACTION_FAILED', adjustedBy: ['orders'] },
      extensions: { 'x-ticket': 'SHOP-1', 'x-owner': 'checkout-team', orders: { owner: 'checkout-team' } },
    });
    expect(summaries.api?.classification.message).toContain('CIGE step e2 (order-api) failed: the orders API answered 500');
    expect(summaries.api?.classification.signals).toContain('ticketed');
    // A plain throw from a plugin step says nothing about the flow, so the type is left to the classifier.
    expect(summaries.api).not.toHaveProperty('failureType');
    expect(summaries.api?.classification.signals).toContain('plugin-step-failed:e2');
    expect(summaries.api?.classification.adjustedBy).toEqual(['orders']);
    expect(summaries.api?.classification.signals.filter((signal) => signal === 'status:failed')).toHaveLength(1);
    expect(summaries.pass?.extensions).toEqual({ orders: { owner: null } });
  });

  it('points a failure at its environment, its refs, and the command that replays it', () => {
    expect(summaries.stale).toMatchObject({
      buildRef: 'releases/test-build.md',
      resolveRefs: 'npx e2e-cige refs stale',
      replay: { environment: 'memory', command: 'npx e2e-cige replay stale' },
    });
    // The config's refs.spec resolver covers the missing specRef.
    expect(summaries.stale?.classification.signals).not.toContain('missing-spec-ref');
    expect(summaries.stale?.classification.signals).not.toContain('missing-build-ref');
    expect(summaries['variants.voucher']?.replay.command).toBe('npx e2e-cige replay variants --variant voucher');
    expect(summaries.pass?.classification.signals).not.toContain('missing-spec-ref');
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

  it('keeps the other cases and every refs directory when a run left cases out, as e2e-cige replay does', async () => {
    writeFileSync(path.join(dir(), 'pass.run-summary.json'), '{}');
    writeFileSync(path.join(dir(), 'stale.memory.default.run-summary.json'), '{"result":"fail"}');
    mkdirSync(path.join(dir(), 'pass.refs'), { recursive: true });
    const only = outcome.report.run.results.map((result) => (result.tags.includes('cige:stale') ? result : { ...result, selected: false }));
    await reporter().onRunFinished!(finished({ ...outcome.report, run: { ...outcome.report.run, results: only } }), new AbortController().signal);
    expect(readdirSync(dir())).toContain('pass.run-summary.json');
    expect(readdirSync(dir())).toContain('pass.refs');
    // The other naming of the case it ran goes, so no stale verdict contradicts the new one.
    expect(readdirSync(dir())).not.toContain('stale.memory.default.run-summary.json');
    expect(readdirSync(dir())).toContain('stale.run-summary.json');
  });

  it('keeps a sibling variant when a run replays only one variant of a case', async () => {
    writeFileSync(path.join(dir(), 'variants.voucher.run-summary.json'), '{"result":"fail"}');
    const variants = outcome.report.run.results
      .filter((result) => result.tags.includes('cige:variants'))
      .map((result) => (result.tags.includes('cige:variants/card') ? result : { ...result, selected: false }));
    await reporter().onRunFinished!(finished({ ...outcome.report, run: { ...outcome.report.run, results: variants } }), new AbortController().signal);
    expect(readdirSync(dir())).toContain('variants.voucher.run-summary.json');
    expect(readdirSync(dir())).toContain('variants.card.run-summary.json');
  });

  it('passes the config file to the commands a summary prints, when it is not the default', async () => {
    await cige({
      cases: 'cases/*.cige.json',
      configFile: 'config/cige.shop.ts',
      environments: { memory: { reset: () => undefined } },
      refs: { build: () => undefined },
    }).onRunFinished!(finished(outcome.report), new AbortController().signal);
    const stale = JSON.parse(readFileSync(path.join(dir(), 'stale.run-summary.json'), 'utf8')) as CigeRunSummary;
    expect(stale.replay.command).toBe('npx e2e-cige replay stale --config config/cige.shop.ts');
    expect(stale.resolveRefs).toBe('npx e2e-cige refs stale --config config/cige.shop.ts');
  });

  it('counts the cases that could not be fully triaged, under the run summary', async () => {
    const rows = await cige({ cases: 'cases/*.cige.json', refs: { build: () => undefined } }).onRunFinished!(finished(outcome.report), new AbortController().signal);
    // Only `pass` has a specRef; `stale` names an environment this reporter's config does not declare.
    // The reporter config here has no plugins, so `api` counts by its missing specRef alone.
    expect(rows).toContainEqual({ label: 'CIGE gaps', text: "13 cases can't be fully classified or replayed: npx e2e-cige check" });
    const stale = JSON.parse(readFileSync(path.join(dir(), 'stale.run-summary.json'), 'utf8')) as CigeRunSummary;
    expect(stale.classification.signals).toContain('missing-spec-ref');
    expect(stale.classification.signals).not.toContain('missing-build-ref');
  });

  it('clears old summaries when a run has no CIGE result to write', async () => {
    const none = { ...outcome.report, run: { ...outcome.report.run, results: [] } };
    await reporter().onRunFinished!(finished(none), new AbortController().signal);
    expect(readdirSync(dir()).filter((file) => file.endsWith('.run-summary.json'))).toEqual([]);
    expect(readdirSync(dir())).toContain('notes.txt');
  });
});

describe('the e2e-cige command on the same project', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: PROJECT, encoding: 'utf8' });

  it('resolves a case refs on request, recording a resolver that failed', () => {
    const result = cli('refs', 'stale');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('the spec resolver failed: the wiki is down');
    const dir = path.join(PROJECT, '.e2e', 'cige', 'stale.refs');
    expect(readFileSync(path.join(dir, 'build.md'), 'utf8')).toBe('Release notes for test-build from releases/test-build.md\n');
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')) as Record<string, unknown>;
    expect(index).toMatchObject({
      testId: 'stale',
      build: 'test-build',
      environment: 'memory',
      refs: { build: { pointer: 'releases/test-build.md', text: 'build.md' }, spec: { error: 'the wiki is down' } },
    });
  });

  it('replays one case alone after resetting its environment, and exits as e2e did', () => {
    rmSync(path.join(PROJECT, 'reset-ran.txt'), { force: true });
    const result = cli('replay', 'stale');
    expect(result.stderr).toContain('e2e-cige: resetting memory');
    expect(result.stderr).toContain('e2e run --config e2e.config.ts --tag cige:stale --no-cache');
    expect(result.status).toBe(1);
    expect(existsSync(path.join(PROJECT, 'reset-ran.txt'))).toBe(true);
    const report = JSON.parse(readFileSync(path.join(PROJECT, '.e2e', 'report.json'), 'utf8')) as typeof outcome.report;
    expect(report.run.results.filter((entry) => entry.selected).map((entry) => entry.titlePath.at(-1))).toEqual(['A shopper can open checkout']);
  }, 120_000);

  it('runs an environment action and refuses one the environment lacks', () => {
    rmSync(path.join(PROJECT, 'reset-ran.txt'), { force: true });
    expect(cli('env', 'reset', 'memory').status).toBe(0);
    expect(existsSync(path.join(PROJECT, 'reset-ran.txt'))).toBe(true);
    const missing = cli('env', 'teardown', 'memory');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('environment "memory" has no teardown action');
  });
});
