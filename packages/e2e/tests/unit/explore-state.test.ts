import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { summaryRows } from '../../src/explore/reporter.ts';
import { clip, ExploreState } from '../../src/explore/state.ts';

const SCHEMA_PATH = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema', 'report-v1.schema.json');

/** Validates one `run.explore` value against its schema definition. */
function assertValidExplore(value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { $id: string };
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/explore`);
  if (validate === undefined) throw new Error('explore definition missing from the report schema');
  if (!validate(value)) throw new Error(JSON.stringify(validate.errors, null, 2));
}

function finding(state: ExploreState, overrides: Partial<Parameters<ExploreState['addFinding']>[0]> = {}) {
  return state.addFinding({
    title: 'Total shows $0.00',
    kind: 'issue',
    severity: 4,
    expected: 'The total reflects the cart',
    actual: 'Total: $0.00',
    reproduction: ['Add two items', 'Open the cart'],
    ...overrides,
  });
}

describe('ExploreState', () => {
  it('records steps in order with their outcome and timing', () => {
    let clock = 1_000;
    const state = new ExploreState('Explore checkout', { maxSteps: 4, timeoutMs: 300_000 }, () => clock);
    expect(state.beginStep('Cart', 'Add two items and open the cart')).toBe(1);
    clock += 2_500;
    const step = state.endStep('passed', 'Cart opened with both items');
    expect(step).toMatchObject({ index: 1, title: 'Cart', status: 'passed', durationMs: 2_500, summary: 'Cart opened with both items' });
    expect(state.beginStep('Checkout', 'Pay for the cart')).toBe(2);
    state.endStep('failed', 'agent.act failed: the pay button did nothing', 'ACTION_FAILED');
    expect(state.steps.map((entry) => entry.status)).toEqual(['passed', 'failed']);
    expect(state.steps[1]!.errorCode).toBe('ACTION_FAILED');
  });

  it('refuses to open a second step while one is open, and to close none', () => {
    const state = new ExploreState('goal', { maxSteps: 2, timeoutMs: 300_000 });
    expect(() => state.endStep('passed')).toThrow(/no exploration step is open/);
    state.beginStep('One', 'do one');
    expect(() => state.beginStep('Two', 'do two')).toThrow(/step 1 is still open/);
  });

  it('attributes findings to the step in progress and keeps them ordered', () => {
    const state = new ExploreState('goal', { maxSteps: 2, timeoutMs: 300_000 });
    const early = finding(state, { title: 'Reported before any step' });
    expect(early.step).toBeUndefined();
    state.beginStep('Cart', 'open the cart');
    const inStep = finding(state);
    expect(inStep).toMatchObject({ index: 1, step: 1, kind: 'issue', severity: 4 });
    state.attachEvidence(inStep.id, 'explore/run/finding-2.png');
    expect(state.findings[1]!.screenshot).toBe('explore/run/finding-2.png');
    expect(state.issues).toHaveLength(2);
  });

  it('counts failed and blocked steps in a row, skipping steps that ended at their limit', () => {
    const state = new ExploreState('goal', { maxSteps: 8, timeoutMs: 300_000 });
    const record = (status: 'passed' | 'failed' | 'blocked' | 'exhausted') => {
      state.beginStep(status, `step ${status}`);
      state.endStep(status);
    };
    record('failed');
    record('passed');
    expect(state.consecutiveFailures()).toBe(0);
    record('failed');
    record('exhausted');
    record('blocked');
    expect(state.consecutiveFailures()).toBe(2);
    record('failed');
    expect(state.consecutiveFailures()).toBe(3);
  });

  it('does not count a failed step that recorded a finding', () => {
    const state = new ExploreState('goal', { maxSteps: 8, timeoutMs: 300_000 });
    state.beginStep('Orders', 'inspect orders');
    finding(state);
    state.endStep('failed', 'agent.act failed: count mismatch reported');
    state.beginStep('Account', 'save the profile');
    state.endStep('failed');
    expect(state.consecutiveFailures()).toBe(1);
  });

  it('snapshots a schema-valid explore block with bounded text', () => {
    const state = new ExploreState('goal', { maxSteps: 2, timeoutMs: 300_000 });
    state.beginStep('x'.repeat(400), 'y'.repeat(5_000));
    state.endStep('passed', 'z'.repeat(9_000));
    finding(state, { title: 't'.repeat(300), reproduction: Array.from({ length: 30 }, () => 'r'.repeat(900)) });
    state.summary = 's'.repeat(9_000);
    state.ended = 'finished';
    const snapshot = state.snapshot();
    assertValidExplore(snapshot);
    expect(snapshot.steps[0]!.title).toHaveLength(200);
    expect(snapshot.steps[0]!.instruction).toHaveLength(2_000);
    expect(snapshot.findings[0]!.reproduction).toHaveLength(20);
    expect(snapshot.summary).toHaveLength(4_000);
  });

  it('clip trims and marks truncation, counting code points so no surrogate pair is split', () => {
    expect(clip('  hello  ', 10)).toBe('hello');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…');
    expect(clip('😀😀', 2)).toBe('😀😀');
  });
});

describe('summaryRows', () => {
  it('summarizes steps, findings by severity, and the assessment', () => {
    const state = new ExploreState('goal', { maxSteps: 4, timeoutMs: 300_000 });
    state.beginStep('Cart', 'a');
    state.endStep('passed');
    state.beginStep('Checkout', 'b');
    state.endStep('exhausted');
    finding(state, { title: 'Minor misalignment', kind: 'warning', severity: 2 });
    finding(state, { title: 'Total shows $0.00', severity: 4, path: '/cart' });
    state.summary = 'Checkout is broken.';
    state.ended = 'step-limit';
    const rows = summaryRows(state);
    expect(rows.map((row) => row.label.trim())).toEqual(['Explored', 'Findings', 'S4 issue', 'S2 warning', 'Assessment']);
    expect(rows[0]!.text).toBe('2 steps (1 passed, 1 ended at their limit); ended: the step limit was reached');
    expect(rows[1]!.text).toBe('1 issue, 1 warning');
    expect(rows[2]!.text).toBe('Total shows $0.00 (/cart)');
  });

  it('says none when nothing was found', () => {
    const state = new ExploreState('goal', { maxSteps: 4, timeoutMs: 300_000 });
    state.ended = 'finished';
    expect(summaryRows(state).map((row) => row.text)).toEqual(['0 steps (0 passed); ended: the agent covered the goal', 'none']);
  });
});
