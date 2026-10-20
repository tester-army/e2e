import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAgentError, type ActOptions, type AssertOptions, type TestFixtures } from 'e2e';
import { afterEach, describe, expect, it } from 'vitest';

import { breakingGuardrail, createGuardrailMonitor, violatedGuardrail } from '../src/guardrails.ts';
import { loadCigeCases, loadCigeFile } from '../src/load.ts';
import { actInstruction, GUARDRAIL_HEADING, intentAssertion, renderAgentContext } from '../src/render.ts';
import { missingHooks, runCige } from '../src/run.ts';
import { parseCige, type CigeTestCase } from '../src/schema.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cige-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const CHECKOUT: CigeTestCase = {
  id: 'checkout',
  Context: {
    system: 'Shop',
    open: '/cart',
    preconditions: ['The cart holds one item', { hook: 'seedCart', description: 'A discount code SAVE10 exists' }],
    specRef: 'specs/checkout.md',
  },
  Intent: {
    statement: 'A shopper can check out with a discount',
    success: ['The confirmation shows an order number'],
    evidence: [{ id: 'order-record', hook: 'orderExists' }, 'the total shows the discount'],
  },
  Guardrails: ['Use only the test card', { id: 'no-refund', rule: 'Never refund an order', deny: { actions: ['tool:refund'], summary: ['refund'] } }],
  Execution: [
    { id: 'e1', step: 'apply the code {code}', params: { code: 'SAVE10' } },
    { id: 'e2', verify: 'the discount is applied' },
    { id: 'e3', step: 'pay with the test card' },
  ],
};

interface Call {
  readonly api: string;
  readonly text: string;
  readonly options?: unknown;
}

function fakeFixtures(behavior: { act?: (text: string, options: ActOptions | undefined) => Promise<void> } = {}): { fixtures: TestFixtures; calls: Call[] } {
  const calls: Call[] = [];
  const agent = {
    async act(text: string, options?: ActOptions) {
      calls.push({ api: 'agent.act', text, options });
      await behavior.act?.(text, options);
      return { summary: 'done', modelCalls: 1, actions: 1 };
    },
    async assert(text: string, options?: AssertOptions) {
      calls.push({ api: 'agent.assert', text, options });
    },
    async waitFor() {},
    async extract() {
      return {};
    },
  };
  const app = {
    async open(target?: string) {
      calls.push({ api: 'app.open', text: target ?? '' });
    },
  };
  return { fixtures: { agent, app, screen: {}, platform: 'web' } as unknown as TestFixtures, calls };
}

describe('render', () => {
  const testCase = parseCige(CHECKOUT);

  it('keeps guardrails and pointers out of agentContext', () => {
    const context = renderAgentContext(testCase)!;
    expect(context).toContain('System under test: Shop');
    expect(context).toContain('- The cart holds one item');
    expect(context).toContain('- A discount code SAVE10 exists');
    expect(context).not.toContain('specs/checkout.md');
    expect(context).not.toContain('refund');
  });

  it('puts every guardrail on each act instruction', () => {
    const instruction = actInstruction(testCase, testCase.execution[0]!);
    expect(instruction.startsWith('apply the code {code}\n\n')).toBe(true);
    expect(instruction).toContain(GUARDRAIL_HEADING);
    expect(instruction).toContain('- [g1] Use only the test card');
    expect(instruction).toContain('- [no-refund] Never refund an order');
  });

  it('judges Intent with its success and failure criteria', () => {
    expect(intentAssertion(testCase)).toBe('A shopper can check out with a discount\n\nAll of these hold:\n- The confirmation shows an order number');
  });
});

describe('load', () => {
  it('reads prompt fragments beside the file and sorts the glob', () => {
    const dir = project({
      'tests/cige/b.cige.json': JSON.stringify({ id: 'b', Context: { prompts: ['../fragments/login.md'] }, Intent: 'B holds', Execution: ['do b'] }),
      'tests/cige/a.cige.json': JSON.stringify({ id: 'a', Context: {}, Intent: 'A holds', Execution: ['do a'] }),
      'tests/fragments/login.md': 'Sign in with the "Continue with email" button.\n',
    });
    const cases = loadCigeCases('tests/**/*.cige.json', { root: dir });
    expect(cases.map((testCase) => testCase.id)).toEqual(['a', 'b']);
    expect(renderAgentContext(cases[1]!)).toBe('Sign in with the "Continue with email" button.');
  });

  it('refuses two cases with one id', () => {
    const dir = project({
      'one.cige.json': JSON.stringify({ Context: {}, Intent: 'Same intent', Execution: ['x'] }),
      'two.cige.json': JSON.stringify({ Context: {}, Intent: 'Same intent', Execution: ['y'] }),
    });
    expect(() => loadCigeCases('*.cige.json', { root: dir })).toThrow(/id "same-intent" is already the id of/);
  });

  it('names a missing prompt, bad JSON, and an oversized step', () => {
    const dir = project({
      'missing.cige.json': JSON.stringify({ Context: { prompts: ['nope.md'] }, Intent: 'x', Execution: ['y'] }),
      'broken.cige.json': '{ "Context": ',
      'huge.cige.json': JSON.stringify({ Context: {}, Intent: 'x', Execution: ['y'], Guardrails: ['z'.repeat(9000)] }),
    });
    expect(() => loadCigeFile(path.join(dir, 'missing.cige.json'))).toThrow(/cannot read "nope.md"/);
    expect(() => loadCigeFile(path.join(dir, 'broken.cige.json'))).toThrow(/invalid CIGE test case/);
    expect(() => loadCigeFile(path.join(dir, 'huge.cige.json'))).toThrow(/Execution e1 renders to \d+ bytes/);
  });
});

describe('guardrails', () => {
  const testCase = parseCige(CHECKOUT);

  it('matches actions by name or prefix and summaries by pattern', () => {
    expect(breakingGuardrail(testCase.guardrails, { action: 'tool:refund', summary: 'x' })?.id).toBe('no-refund');
    expect(breakingGuardrail(testCase.guardrails, { action: 'tap', summary: 'tap button "Refund order"' })?.id).toBe('no-refund');
    expect(breakingGuardrail(testCase.guardrails, { action: 'tap', summary: 'tap button "Pay"' })).toBeUndefined();
    const prefixed = parseCige({ Context: {}, Intent: 'x', Guardrails: [{ rule: 'no tools', deny: { actions: ['tool:*'] } }], Execution: ['y'] });
    expect(breakingGuardrail(prefixed.guardrails, { action: 'tool:seed', summary: '' })?.id).toBe('g1');
  });

  it('stops the step with POLICY_DENIED and a message the reporter reads back', async () => {
    const monitor = createGuardrailMonitor(testCase.guardrails)!;
    const thrown = await Promise.resolve()
      .then(() => monitor({ index: 1, action: 'tap', summary: 'tap button "Refund order"', source: 'replay' }))
      .catch((error: unknown) => error);
    expect(isAgentError(thrown)).toBe(true);
    expect(isAgentError(thrown) && thrown.code).toBe('POLICY_DENIED');
    expect(violatedGuardrail(isAgentError(thrown) ? `agent.act onAction failed: ${thrown.message}` : undefined)).toBe('no-refund');
  });

  it('passes no hook when no guardrail denies anything', () => {
    expect(createGuardrailMonitor(parseCige({ Context: {}, Intent: 'x', Guardrails: ['prose only'], Execution: ['y'] }).guardrails)).toBeUndefined();
  });
});

describe('runCige', () => {
  const testCase = parseCige(CHECKOUT);

  it('runs preconditions, Execution, evidence, then Intent, in order', async () => {
    const { fixtures, calls } = fakeFixtures();
    const seen: string[] = [];
    await runCige(testCase, fixtures, {
      hooks: {
        seedCart: () => void seen.push('seedCart'),
        orderExists: () => {
          seen.push('orderExists');
          return true;
        },
      },
    });
    expect(seen).toEqual(['seedCart', 'orderExists']);
    expect(calls.map((call) => `${call.api} ${call.text.split('\n')[0]}`)).toEqual([
      'app.open /cart',
      'agent.act apply the code {code}',
      'agent.assert the discount is applied',
      'agent.act pay with the test card',
      'agent.assert the total shows the discount',
      'agent.assert A shopper can check out with a discount',
    ]);
    const first = calls[1]!.options as ActOptions;
    expect(first.params).toEqual({ code: 'SAVE10' });
    expect(typeof first.onAction).toBe('function');
  });

  it('fails evidence a hook rejects, after every step ran', async () => {
    const { fixtures, calls } = fakeFixtures();
    const run = runCige(testCase, fixtures, { hooks: { seedCart: () => undefined, orderExists: () => false } });
    await expect(run).rejects.toThrow('CIGE evidence order-record not satisfied: hook orderExists returned false');
    expect(calls.filter((call) => call.api === 'agent.act')).toHaveLength(2);
    expect(calls.at(-1)?.text).not.toContain('A shopper can check out');
  });

  it('reports a failing precondition as test setup', async () => {
    const { fixtures } = fakeFixtures();
    const run = runCige(testCase, fixtures, {
      hooks: {
        seedCart: () => {
          throw new Error('seed API returned 503');
        },
        orderExists: () => true,
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED', message: 'CIGE precondition seedCart failed: seed API returned 503' });
  });

  it('lists the hooks a case names but the suite lacks', () => {
    expect(missingHooks(testCase, { seedCart: () => undefined })).toEqual(['orderExists']);
  });
});
