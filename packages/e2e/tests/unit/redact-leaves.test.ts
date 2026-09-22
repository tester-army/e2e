/** redactLeaves: the ledger over a JSON document, string leaves only, keys and structure intact. */

import { describe, expect, it } from 'vitest';
import { redactLeaves, SecretLedger } from '../../src/internal/redact.ts';

describe('redactLeaves', () => {
  const ledger = new SecretLedger([
    ['brace', '{'],
    ['key', 'target'],
  ]);

  it('redacts string leaves and keeps keys, numbers, booleans, nulls, and nesting', () => {
    const document = {
      target: 'the target is {',
      count: 1,
      ok: true,
      none: null,
      list: ['{', 2, { target: 'target' }],
    };
    expect(redactLeaves(document, ledger.redact)).toEqual({
      target: 'the <secret:key> is <secret:brace>',
      count: 1,
      ok: true,
      none: null,
      list: ['<secret:brace>', 2, { target: '<secret:key>' }],
    });
    expect(document.target).toBe('the target is {');
  });

  it('serializes as JSON.stringify would: binary views untouched, toJSON values replaced by their form', () => {
    const bytes = new Uint8Array([1, 2]);
    const out = redactLeaves(
      { bytes, when: new Date(0), url: new URL('https://x.test/{') },
      ledger.redact,
    );
    expect(out.bytes).toBe(bytes);
    expect(out.when).toBe('1970-01-01T00:00:00.000Z');
    expect(out.url).toBe('https://x.test/<secret:brace>');
  });

  it('drops functions and symbols as JSON.stringify does: gone from an object, null in an array, undefined alone', () => {
    const out = redactLeaves(
      { fn: () => 1, sym: Symbol('s'), list: [() => 1, '{', undefined], kept: 'target' },
      ledger.redact,
    );
    expect(Object.keys(out)).toEqual(['list', 'kept']);
    expect(out.list).toEqual([null, '<secret:brace>', null]);
    expect(out.kept).toBe('<secret:key>');
    expect(redactLeaves(() => 1, ledger.redact)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('returns a string redacted and any other primitive as is', () => {
    expect(redactLeaves('a { b', ledger.redact)).toBe('a <secret:brace> b');
    expect(redactLeaves(3, ledger.redact)).toBe(3);
    expect(redactLeaves(undefined, ledger.redact)).toBeUndefined();
    expect(redactLeaves(null, ledger.redact)).toBeNull();
  });
});
