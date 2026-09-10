import { describe, expect, it } from 'vitest';
import { PLAN_SCHEMA, planInstruction, repairPlan } from '../../src/explore/plan.ts';
import { ExploreState } from '../../src/explore/state.ts';

/** Answers with every field present, as strict providers require; unused ones empty. */
const step = (fields: Partial<Record<'title' | 'instruction' | 'summary', string>>) => ({ decision: 'step' as const, title: '', instruction: '', summary: '', ...fields });
const finish = (fields: Partial<Record<'title' | 'instruction' | 'summary', string>>) => ({ decision: 'finish' as const, title: '', instruction: '', summary: '', ...fields });

describe('PLAN_SCHEMA', () => {

  it('accepts a step with a title and an instruction, and a finish with a summary', () => {
    expect(PLAN_SCHEMA.safeParse(step({ title: 'Cart', instruction: 'Add two items and open the cart' })).success).toBe(true);
    expect(PLAN_SCHEMA.safeParse(finish({ summary: 'Checkout works; the cart total is wrong.' })).success).toBe(true);
  });

  it('requires every field to be present, as strict providers demand', async () => {
    expect(PLAN_SCHEMA.safeParse({ decision: 'step', title: 'Cart', instruction: 'open' }).success).toBe(false);
    const { deriveJsonSchema } = await import('../../src/agent/model/schema.ts');
    const json = (await deriveJsonSchema(PLAN_SCHEMA)) as { required?: string[]; properties?: Record<string, unknown> };
    expect([...(json.required ?? [])].toSorted()).toEqual(Object.keys(json.properties ?? {}).toSorted());
  });

  it('accepts a step with only one of title and instruction filled, and names an empty one', () => {
    expect(PLAN_SCHEMA.safeParse(step({ title: 'Open the cart and check the total against the line prices' })).success).toBe(true);
    expect(PLAN_SCHEMA.safeParse(step({ instruction: 'Open the cart' })).success).toBe(true);
    const empty = PLAN_SCHEMA.safeParse(step({ title: ' ' }));
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['instruction']);
    const noSummary = PLAN_SCHEMA.safeParse(finish({}));
    expect(noSummary.success).toBe(false);
    expect(noSummary.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['summary']);
  });
});

describe('repairPlan', () => {
  it('trims a step and its title, and passes a finish through', () => {
    expect(repairPlan(step({ title: ' Cart ', instruction: ' Open the cart. ' }))).toEqual({ kind: 'step', title: 'Cart', instruction: 'Open the cart.' });
    expect(repairPlan(finish({ summary: ' Checkout works; the cart total is wrong. ' }))).toEqual({ kind: 'finish', summary: 'Checkout works; the cart total is wrong.' });
  });

  it('uses a lone title as the charter and derives the heading from its first clause', () => {
    const charter = 'Open the cart page: add two copies of Dune, then check that the total equals twice the unit price';
    expect(repairPlan(step({ title: charter }))).toEqual({ kind: 'step', title: 'Open the cart page', instruction: charter });
  });

  it('derives a heading for a charter with no title, bounded', () => {
    const long = `${'word '.repeat(40).trim()} then stop`;
    const plan = repairPlan(step({ instruction: long }));
    expect(plan.kind === 'step' && plan.instruction).toBe(long);
    expect(plan.kind === 'step' && plan.title.length).toBeLessThanOrEqual(80);
  });

  it('replaces an over-long title with a derived one', () => {
    expect(repairPlan(step({ title: 'x'.repeat(300), instruction: 'Do the thing' }))).toEqual({ kind: 'step', title: 'Do the thing', instruction: 'Do the thing' });
  });

  it('strips the digit runs a provider pads a field with', () => {
    const padded = `Browse catalog and manage cart nav flow${'1234567890'.repeat(60)}`;
    expect(repairPlan(step({ title: padded }))).toEqual({ kind: 'step', title: 'Browse catalog and manage cart nav flow', instruction: 'Browse catalog and manage cart nav flow' });
    expect(repairPlan(step({ title: 'Sign in', instruction: `Open the sign in page ${'0123456789'.repeat(3)} and sign in` }))).toEqual({ kind: 'step', title: 'Sign in', instruction: 'Open the sign in page and sign in' });
    expect(repairPlan(finish({ summary: `All good.${'9876543210'.repeat(4)}` }))).toEqual({ kind: 'finish', summary: 'All good.' });
    // Numbers a charter can mean are content, not padding: ids, phone numbers, card numbers.
    expect(repairPlan(step({ title: 'Order 1042', instruction: 'Check order #1042 for $28.00' }))).toEqual({ kind: 'step', title: 'Order 1042', instruction: 'Check order #1042 for $28.00' });
    const tracking = 'Confirm tracking number 1234567890123 shows for order 4111111111111111 and phone 5551234567';
    expect(repairPlan(step({ title: 'Tracking', instruction: tracking }))).toEqual({ kind: 'step', title: 'Tracking', instruction: tracking });
  });

  it('accepts a charter far past the report ceiling and leaves its length to the state', () => {
    const huge = `Open the catalog. ${'Check every price and stock count carefully. '.repeat(120)}`;
    expect(PLAN_SCHEMA.safeParse(step({ title: huge })).success).toBe(true);
    const plan = repairPlan(step({ title: huge }));
    expect(plan.kind === 'step' && plan.instruction).toBe(huge.trim());
    expect(plan.kind === 'step' && plan.title).toBe('Open the catalog');
    expect(PLAN_SCHEMA.safeParse(finish({ summary: 's'.repeat(6_000) })).success).toBe(true);
    expect(PLAN_SCHEMA.safeParse(step({ title: 'x'.repeat(8_001) })).success).toBe(false);
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
