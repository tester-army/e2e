import { describe, expect, it } from 'vitest';
import { normalizeStep, PLAN_SCHEMA, planInstruction } from '../../src/explore/plan.ts';
import { ExploreState } from '../../src/explore/state.ts';

describe('PLAN_SCHEMA', () => {
  it('accepts a step with a title and an instruction', () => {
    const parsed = PLAN_SCHEMA.safeParse({ decision: 'step', title: 'Cart', instruction: 'Add two items and open the cart' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a finish with a summary', () => {
    expect(PLAN_SCHEMA.safeParse({ decision: 'finish', summary: 'Checkout works; the cart total is wrong.' }).success).toBe(true);
  });

  it('accepts a step with only one of title and instruction, and names an empty one', () => {
    expect(PLAN_SCHEMA.safeParse({ decision: 'step', title: 'Open the cart and check the total against the line prices' }).success).toBe(true);
    expect(PLAN_SCHEMA.safeParse({ decision: 'step', instruction: 'Open the cart' }).success).toBe(true);
    const empty = PLAN_SCHEMA.safeParse({ decision: 'step', title: ' ' });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['instruction']);
    const finish = PLAN_SCHEMA.safeParse({ decision: 'finish' });
    expect(finish.success).toBe(false);
    expect(finish.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['summary']);
  });
});

describe('normalizeStep', () => {
  it('keeps a short title with its instruction', () => {
    expect(normalizeStep(' Cart ', ' Open the cart. ')).toEqual({ kind: 'step', title: 'Cart', instruction: 'Open the cart.' });
  });

  it('uses a lone title as the charter and derives the heading from its first clause', () => {
    const charter = 'Open the cart page: add two copies of Dune, then check that the total equals twice the unit price';
    expect(normalizeStep(charter, undefined)).toEqual({ kind: 'step', title: 'Open the cart page', instruction: charter });
  });

  it('derives a heading for a charter with no title, bounded', () => {
    const long = `${'word '.repeat(40).trim()} then stop`;
    const plan = normalizeStep(undefined, long);
    expect(plan.kind === 'step' && plan.instruction).toBe(long);
    expect(plan.kind === 'step' && plan.title.length).toBeLessThanOrEqual(80);
  });

  it('replaces an over-long title with a derived one', () => {
    const title = 'x'.repeat(300);
    const plan = normalizeStep(title, 'Do the thing');
    expect(plan).toEqual({ kind: 'step', title: 'Do the thing', instruction: 'Do the thing' });
  });

  it('accepts a charter far past the report ceiling and clips it instead of rejecting it', () => {
    const huge = `Open the catalog. ${'Check every price and stock count carefully. '.repeat(120)}`;
    expect(PLAN_SCHEMA.safeParse({ decision: 'step', title: huge }).success).toBe(true);
    const plan = normalizeStep(huge, undefined);
    expect(plan.kind === 'step' && plan.instruction.length).toBe(2_000);
    expect(plan.kind === 'step' && plan.title).toBe('Open the catalog');
    expect(PLAN_SCHEMA.safeParse({ decision: 'finish', summary: 's'.repeat(6_000) }).success).toBe(true);
    expect(PLAN_SCHEMA.safeParse({ decision: 'step', title: 'x'.repeat(8_001) }).success).toBe(false);
  });
});

describe('planInstruction', () => {
  const fresh = () => new ExploreState('Explore checkout like a first-time buyer', { maxSteps: 6, timeoutMs: 600_000 });

  it('opens with the goal, an empty record, and the two decisions', () => {
    const state = fresh();
    const text = planInstruction(state, { mustFinish: false, remainingMs: 540_000, timeoutMs: 60_000 });
    expect(text).toContain('Goal: Explore checkout like a first-time buyer');
    expect(text).toContain('0 of 6 steps used, about 9 minute(s) left');
    expect(text).toContain('(none yet: this is the first step)');
    expect(text).toContain('"decision": "step"');
    expect(text).toContain('"decision": "finish"');
  });

  it('lists the steps with their outcome and the findings so far', () => {
    const state = fresh();
    state.beginStep('Cart', 'open the cart');
    state.endStep('passed', 'Cart opened');
    state.beginStep('Pay', 'pay for the cart');
    state.endStep('exhausted', 'ran out of actions', 'STEP_BUDGET_EXHAUSTED');
    state.addFinding({ title: 'Total is $0.00', kind: 'issue', severity: 4, expected: 'a total', actual: '$0.00', reproduction: ['open the cart'] });
    const text = planInstruction(state, { mustFinish: false, remainingMs: 300_000, timeoutMs: 60_000 });
    expect(text).toContain('1. [passed] Cart — Cart opened');
    expect(text).toContain('2. [ended at its limit] Pay — ran out of actions');
    expect(text).toContain('- [issue, severity 4] Total is $0.00');
  });

  it('asks only for the assessment when the run must finish', () => {
    const state = fresh();
    const text = planInstruction(state, { mustFinish: true, reason: 'the step limit of 6 is reached', remainingMs: 100_000, timeoutMs: 60_000 });
    expect(text).toContain('The run must end now: the step limit of 6 is reached.');
    expect(text).toContain('"decision": "finish"');
    expect(text).not.toContain('"decision": "step"');
  });
});
