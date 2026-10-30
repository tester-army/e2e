import { describe, expect, it } from 'vitest';
import { expectsPresence, FIXTURES } from '../../evals/planner/fixtures.ts';
import { judgeRubric, judgeRun, type PlannedRun } from '../../evals/planner/judges.ts';

const step = (title: string, instruction: string) => ({ title, instruction });
const failed = (run: PlannedRun, expectation: Parameters<typeof judgeRun>[0]) => judgeRun(expectation, run).filter((judgement) => !judgement.pass).map((judgement) => judgement.judge);

describe('planner eval judges', () => {
  it('judges the decision from how the run ended', () => {
    expect(failed({ ended: 'skipped', steps: [] }, { decision: 'skip' })).toEqual([]);
    expect(failed({ ended: 'step-limit', steps: [step('Cart', 'Open the cart')] }, { decision: 'skip' })).toEqual(['decision']);
    expect(failed({ ended: 'skipped', steps: [] }, { decision: 'explore' })).toEqual(['decision']);
    expect(judgeRun({ decision: 'explore' }, { ended: 'aborted', steps: [] })[0]!.detail).toBe('expected explore, got no step (ended aborted)');
    expect(failed({ ended: 'skipped', steps: [] }, { decision: 'any' })).toEqual([]);
  });

  it('holds the first charter to its rules and every charter to the forbidden ones and the invariants', () => {
    const run: PlannedRun = { ended: 'step-limit', steps: [step('Catalog', 'Add a book'), step('Cart', 'Change a quantity')] };
    expect(failed(run, { decision: 'explore', firstStep: [{ pattern: /cart/i, reason: 'r' }] })).toEqual(['first-step /cart/i']);
    expect(failed(run, { decision: 'explore', forbid: [{ pattern: /quantity/i, reason: 'r' }] })).toEqual(['forbid /quantity/i']);
    expect(failed({ ended: 'finished', steps: [step('Cart', 'Read src/pages/cart.tsx and compare')] }, { decision: 'any' })).toHaveLength(1);
    expect(failed({ ended: 'finished', steps: [step('Cart', 'Check the server logs')] }, { decision: 'any' })).toHaveLength(1);
    expect(failed({ ended: 'finished', steps: [step('Test the app', '')] }, { decision: 'any' })).toHaveLength(1);
    expect(failed({ ended: 'finished', steps: [step('Cart', 'Add Piranesi to the cart and check the total')] }, { decision: 'any' })).toEqual([]);
  });

  it('tells a charter expecting a thing from one checking it is gone, sentence by sentence', () => {
    const newsletter = expectsPresence('newsletter');
    expect(newsletter.test('Open Account. Check that the newsletter checkbox is shown.')).toBe(true);
    expect(newsletter.test('Open Account. Confirm the newsletter option is no longer shown.')).toBe(false);
    expect(newsletter.test('The newsletter was removed. Check the newsletter checkbox is visible.')).toBe(true);
    const flagged = expectsPresence('gift wrap', ['whether', 'if']);
    expect(flagged.test('Check whether the gift wrap option is shown.')).toBe(false);
  });

  it('asks the rubric about every charter and passes on the wanted answer', async () => {
    const prompts: string[] = [];
    const run: PlannedRun = { ended: 'step-limit', steps: [step('Account', 'Save a name')] };
    const judgements = await judgeRubric([{ question: 'Expects a newsletter?', pass: 'no' }], run, async (prompt) => {
      prompts.push(prompt);
      return { answer: 'yes', reason: 'it says so' };
    });
    expect(prompts[0]).toContain('1. Account: Save a name');
    expect(prompts[0]).toContain('Question: Expects a newsletter?');
    expect(judgements).toEqual([{ judge: 'rubric Expects a newsletter?', pass: false, detail: 'yes: it says so' }]);
    expect(await judgeRubric([{ question: 'q', pass: 'no' }], { ended: 'skipped', steps: [] }, () => Promise.reject(new Error('not asked')))).toEqual([]);
  });

  it('keeps fixture ids unique', () => {
    expect(new Set(FIXTURES.map((fixture) => fixture.id)).size).toBe(FIXTURES.length);
  });
});
