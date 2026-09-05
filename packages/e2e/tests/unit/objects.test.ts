import { describe, expect, it } from 'vitest';
import { obj } from '../../src/internal/objects.ts';

describe('obj', () => {
  it('drops undefined-valued keys and keeps every other value, null and falsy included', () => {
    expect(obj({ a: 1, b: undefined, c: null, d: 0, e: '', f: false })).toEqual({
      a: 1,
      c: null,
      d: 0,
      e: '',
      f: false,
    });
  });

  it('types dropped keys as optional without undefined, so the result satisfies exact optional properties', () => {
    const maybe: string | undefined = Math.random() > 2 ? 'never' : undefined;
    const result: { readonly always: number; readonly maybe?: string } = obj({ always: 1, maybe });
    expect(result).toEqual({ always: 1 });
    expect('maybe' in result).toBe(false);
  });
});
