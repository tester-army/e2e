import { describe, expect, it } from 'vitest';
import { didYouMean, suggest } from '../../src/internal/suggest.ts';

const KEYS = ['targets', 'tests', 'timeout', 'retries', 'workers', 'reporters', 'agent', 'cache'];

describe('suggest', () => {
  it('finds the candidate one typo away', () => {
    expect(suggest('target', KEYS)).toBe('targets');
    expect(suggest('retires', KEYS)).toBe('retries');
    expect(suggest('reporter', KEYS)).toBe('reporters');
    expect(suggest('Timeout', KEYS)).toBe('timeout');
  });

  it('allows more edits for longer words and none beyond a third of the length', () => {
    expect(suggest('reprters', KEYS)).toBe('reporters');
    expect(suggest('tests/exmple.e2e.ts', ['tests/example.e2e.ts', 'tests/other.e2e.ts'])).toBe('tests/example.e2e.ts');
    expect(suggest('xyz', KEYS)).toBeUndefined();
    expect(suggest('completelydifferent', KEYS)).toBeUndefined();
  });

  it('returns nothing for an exact match or an empty candidate list', () => {
    expect(suggest('targets', KEYS)).toBeUndefined();
    expect(suggest('targets', [])).toBeUndefined();
  });

  it('formats a message tail only when there is a suggestion', () => {
    expect(didYouMean('target', KEYS)).toBe('; did you mean "targets"?');
    expect(didYouMean('nope', KEYS)).toBe('');
  });
});
