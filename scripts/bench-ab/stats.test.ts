import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { median, pairedDelta, quantile, seededRandom, verdictOf } from './stats.ts';

describe('quantile', () => {
  it('interpolates between the neighbours of an unsorted list', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
    assert.ok(Number.isNaN(median([])));
  });
});

describe('verdictOf', () => {
  it('reads an interval against the dead zone', () => {
    assert.equal(verdictOf(-0.3, -0.1, 0.05), 'faster');
    assert.equal(verdictOf(0.1, 0.3, 0.05), 'slower');
    assert.equal(verdictOf(-0.02, 0.03, 0.05), 'same');
    assert.equal(verdictOf(-0.02, 0.08, 0.05), 'unresolved');
    assert.equal(verdictOf(-0.08, -0.02, 0.05), 'unresolved');
  });
});

describe('pairedDelta', () => {
  it('finds a consistent 40% drop through noise', () => {
    const random = seededRandom(7);
    const pairs = Array.from({ length: 10 }, () => {
      const base = 1000 * (1 + (random() - 0.5) * 0.1);
      return [base, base * 0.6 * (1 + (random() - 0.5) * 0.1)] as const;
    });
    const delta = pairedDelta(pairs, { threshold: 0.05 });
    assert.equal(delta.verdict, 'faster');
    assert.ok(delta.estimate < -0.35 && delta.estimate > -0.45, `estimate ${delta.estimate}`);
    assert.ok(delta.low <= delta.estimate && delta.estimate <= delta.high);
  });

  it('calls identical builds the same, and ignores one wild pair', () => {
    const pairs = Array.from({ length: 12 }, (_, index) => [1000 + index, 1000 + index] as const);
    const delta = pairedDelta([...pairs, [1000, 5000]], { threshold: 0.05 });
    assert.equal(delta.verdict, 'same');
    assert.equal(delta.estimate, 0);
  });

  it('is reproducible from its seed', () => {
    const pairs = [[100, 110], [100, 95], [100, 120], [100, 101]] as const;
    assert.deepEqual(pairedDelta(pairs, { threshold: 0.05, seed: 3 }), pairedDelta(pairs, { threshold: 0.05, seed: 3 }));
  });

  it('drops pairs without two positive durations and resolves nothing from one pair', () => {
    assert.equal(pairedDelta([[0, 0], [0, 10]], { threshold: 0.05 }).pairs, 0);
    assert.equal(pairedDelta([[100, 50]], { threshold: 0.05 }).verdict, 'unresolved');
  });
});
