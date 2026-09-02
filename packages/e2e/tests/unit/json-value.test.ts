import { describe, expect, it } from 'vitest';
import { validateJsonValue } from '../../src/internal/json-value.ts';

describe('validateJsonValue', () => {
  it('accepts the same object reached twice by different paths', () => {
    const shared = { a: 1 };
    expect(() => validateJsonValue({ p: shared, q: shared, r: [shared, shared] }, 'params')).not.toThrow();
  });

  it('rejects an object that contains itself', () => {
    const self: Record<string, unknown> = {};
    self['me'] = self;
    expect(() => validateJsonValue(self, 'params')).toThrow(/contains a cycle/);
    const list: unknown[] = [];
    list.push({ list });
    expect(() => validateJsonValue(list, 'params')).toThrow(/contains a cycle/);
  });

  it('rejects non-plain prototypes and non-finite numbers', () => {
    expect(() => validateJsonValue(new Map(), 'params')).toThrow(/must be JSON-safe/);
    expect(() => validateJsonValue({ n: Number.NaN }, 'params')).toThrow(/non-finite/);
    expect(() => validateJsonValue(Object.create(null), 'params')).not.toThrow();
  });

  it('enforces maxDepth', () => {
    expect(() => validateJsonValue({ a: { b: { c: 1 } } }, 'params', { maxDepth: 2 })).toThrow(/levels/);
    expect(() => validateJsonValue({ a: { b: 1 } }, 'params', { maxDepth: 2 })).not.toThrow();
  });
});
