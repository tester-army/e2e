import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BaselineMatcher, loadBaseline, MATCH_THRESHOLD, similarity, type BaselineFinding } from '../../src/explore/baseline.ts';
import { ExploreState } from '../../src/explore/state.ts';

function baselineFinding(overrides: Partial<BaselineFinding> & Pick<BaselineFinding, 'id' | 'title'>): BaselineFinding {
  return { kind: 'issue', severity: 4, expected: 'The total reflects the cart', actual: 'Total: $0.00', ...overrides };
}

const CART = baselineFinding({ id: 'b-cart', title: 'Cart total shows $0.00 with two items' });
const FOOTER = baselineFinding({ id: 'b-footer', title: 'Footer misspells Receive', kind: 'warning', severity: 1, expected: 'Receive', actual: 'Recieve' });
const ORDERS = baselineFinding({ id: 'b-orders', title: 'Orders page says 3 orders but lists only 2', expected: 'Three orders listed', actual: 'Two rows under a heading that says 3' });

describe('similarity', () => {
  it('is 1 for the same title however it is cased or punctuated, whatever the detail says', () => {
    expect(similarity({ title: 'Cart total shows $0.00 with two items!', expected: 'x', actual: 'y' }, CART)).toBe(1);
    expect(similarity({ title: 'cart TOTAL shows 0.00 with two items', expected: '', actual: '' }, CART)).toBe(1);
  });

  it('reads two descriptions of one defect as alike and two defects as apart', () => {
    const reworded = { title: 'Cart total stays at $0.00 after adding two items', expected: 'The total equals the sum of both items', actual: 'The cart shows Total: $0.00' };
    expect(similarity(reworded, CART)).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(similarity(reworded, FOOTER)).toBeLessThan(MATCH_THRESHOLD);
    expect(similarity(reworded, ORDERS)).toBeLessThan(MATCH_THRESHOLD);
  });

  it('is 0 when neither side has a word to compare', () => {
    expect(similarity({ title: '!', expected: '', actual: '' }, { ...CART, title: '?', expected: '', actual: '' })).toBe(0);
  });
});

describe('BaselineMatcher', () => {
  it('claims each baseline finding once, for the arrival that reads most like it, and keeps the rest as not seen', () => {
    const matcher = new BaselineMatcher({ source: 'base.json', goal: 'g', findings: [CART, FOOTER, ORDERS] });
    expect(matcher.match({ title: 'Footer misspells Receive', expected: 'Receive', actual: 'Recieve' })?.id).toBe('b-footer');
    // A second report of the footer typo reads like nothing left: the one baseline entry is spent.
    expect(matcher.match({ title: 'Footer misspells Receive', expected: 'Receive', actual: 'Recieve' })).toBeUndefined();
    expect(matcher.match({ title: 'Checkout button stays disabled', expected: 'Pay enabled', actual: 'Pay disabled' })).toBeUndefined();
    expect(matcher.notSeen.map((finding) => finding.id)).toEqual(['b-cart', 'b-orders']);
  });
});

describe('ExploreState with a baseline', () => {
  it('labels each finding, names the baseline finding a known one reads like, and closes the record with the tally', () => {
    const listened: unknown[] = [];
    const state = new ExploreState('Explore checkout', { maxSteps: 4, timeoutMs: 300_000 }, () => 1_000, {
      source: 'main/report.json',
      goal: 'Explore checkout on main',
      findings: [CART, FOOTER],
    });
    state.subscribe((progress) => listened.push(progress));
    state.beginStep('Cart', 'open the cart');
    const known = state.addFinding({ title: 'Cart total shows $0.00 with two items', kind: 'issue', severity: 4, expected: 'sum', actual: '$0.00', reproduction: [] });
    const fresh = state.addFinding({ title: 'Coupon field accepts an expired code', kind: 'issue', severity: 3, expected: 'rejected', actual: 'accepted', reproduction: [] });
    expect(known).toMatchObject({ novelty: 'known', baselineFindingId: 'b-cart' });
    expect(fresh).toMatchObject({ novelty: 'new' });
    expect(fresh.baselineFindingId).toBeUndefined();
    state.endStep('passed');
    state.end('finished', 'done');
    const baseline = { source: 'main/report.json', goal: 'Explore checkout on main', findings: 2, known: 1, new: 1, notSeen: [{ id: 'b-footer', kind: 'warning', severity: 1, title: 'Footer misspells Receive' }] };
    expect(state.snapshot().baseline).toEqual(baseline);
    expect(listened.at(-1)).toEqual({ phase: 'finished', ended: 'finished', summary: 'done', baseline });
  });

  it('records nothing about a baseline when none was given', () => {
    const state = new ExploreState('goal', { maxSteps: 2, timeoutMs: 300_000 });
    const finding = state.addFinding({ title: 't', kind: 'issue', severity: 2, expected: 'e', actual: 'a', reproduction: [] });
    expect('novelty' in finding).toBe(false);
    expect('baseline' in state.snapshot()).toBe(false);
    state.end('finished');
    expect(state.baseline).toBeUndefined();
  });
});

describe('loadBaseline', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function project(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-baseline-'));
    dirs.push(dir);
    return dir;
  }

  function write(dir: string, name: string, document: unknown): string {
    const file = path.join(dir, name);
    writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
    return file;
  }

  const finding = { id: 'f1', index: 0, kind: 'issue', severity: 4, title: 'Cart total shows $0.00', expected: 'sum', actual: '$0.00', reproduction: [], reportedAt: '2026-01-01T00:00:00.000Z' };
  const report = (explore: unknown) => ({ schemaVersion: 'report-1', run: { explore } });

  it('reads the goal and the findings of an explore report, naming the file relative to the project root', () => {
    const dir = project();
    write(dir, 'base.json', report({ goal: 'Explore checkout', findings: [finding] }));
    expect(loadBaseline(path.join(dir, 'base.json'), dir)).toEqual({
      source: 'base.json',
      goal: 'Explore checkout',
      findings: [{ id: 'f1', kind: 'issue', severity: 4, title: 'Cart total shows $0.00', expected: 'sum', actual: '$0.00' }],
    });
    // A file outside the project keeps its absolute path, since a relative one would point nowhere useful.
    const outside = write(project(), 'base.json', report({ goal: 'g', findings: [] }));
    expect(loadBaseline(outside, dir).source).toBe(outside);
  });

  it('rejects a missing file, a non-JSON file, a foreign document, a test run, and a malformed finding as INVALID_BASELINE', () => {
    const dir = project();
    const expectInvalid = (file: string, reason: string) => {
      expect(() => loadBaseline(file, dir)).toThrow(
        expect.objectContaining({ code: 'INVALID_BASELINE', message: `--baseline ${file}: ${reason}; pass the report.json of an earlier e2e explore run` }),
      );
    };
    expectInvalid(path.join(dir, 'missing.json'), 'no such file');
    expectInvalid(write(dir, 'text.json', 'not json'), 'not a JSON document');
    expectInvalid(write(dir, 'foreign.json', { schemaVersion: 'other-1', run: {} }), 'not a report-1 document');
    expectInvalid(write(dir, 'tests.json', { schemaVersion: 'report-1', run: { results: [] } }), 'the report holds no exploration record (was it written by e2e explore?)');
    expectInvalid(write(dir, 'broken.json', report({ goal: 'g', findings: [{ ...finding, severity: 9 }] })), 'a finding in the report is malformed');
  });
});
