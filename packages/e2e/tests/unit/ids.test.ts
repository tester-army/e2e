import { describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  canonicalJson,
  encodeTitle,
  resultId,
  setupTestId,
  testId,
  uuidv7,
  validateTitle,
} from '../../src/internal/ids.ts';

describe('encodeTitle', () => {
  it('percent-encodes every other byte as uppercase %HH', () => {
    expect(encodeTitle('a b')).toBe('a%20b');
    expect(encodeTitle('a/b')).toBe('a%2Fb');
    expect(encodeTitle('a%b')).toBe('a%25b');
    expect(encodeTitle('a:b')).toBe('a%3Ab');
  });

  it('applies NFC normalization, then encodes the UTF-8 bytes', () => {
    const decomposed = 'e\u0301'; // e + combining acute
    expect(encodeTitle(decomposed)).toBe('%C3%A9');
    expect(encodeTitle('日')).toBe('%E6%97%A5');
  });
});

describe('validateTitle', () => {
  it('rejects an empty title, one over 512 UTF-8 bytes, and NUL', () => {
    expect(validateTitle('')).not.toBeNull();
    expect(validateTitle('ż'.repeat(257))).not.toBeNull();
    expect(validateTitle('a'.repeat(512))).toBeNull();
    expect(validateTitle('a\u0000b')).not.toBeNull();
  });
});

describe('test IDs', () => {
  it('joins the file and encoded title path with ::', () => {
    expect(testId('tests/auth.e2e.ts', ['login', 'user can sign in'])).toBe(
      'tests/auth.e2e.ts::login::user%20can%20sign%20in',
    );
  });

  it('is unambiguous because % and : are encoded', () => {
    expect(testId('t.ts', ['a::b'])).toBe('t.ts::a%3A%3Ab');
  });

  it('pins the id of a non-ASCII title path: --last-failed matches ids from an earlier report', () => {
    expect(testId('tests/koszyk.e2e.ts', ['zakupy', 'płaci kartą', 'cafe\u0301'])).toBe(
      'tests/koszyk.e2e.ts::zakupy::p%C5%82aci%20kart%C4%85::caf%C3%A9',
    );
  });

  it('prefixes setup IDs', () => {
    expect(setupTestId('t.ts', ['auth'])).toBe('setup::t.ts::auth');
  });
});

describe('canonicalJson (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code units', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined object members and nullifies undefined array items', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('resultId', () => {
  it('is SHA-256/JCS of { testId, targetId, agent }, so a test run as two agents has two ids', () => {
    expect(resultId('t.ts::a', 'web', 'default')).toBe(canonicalDigest({ testId: 't.ts::a', targetId: 'web', agent: 'default' }));
    expect(resultId('t.ts::a', 'web', 'default')).toMatch(/^[0-9a-f]{64}$/);
    expect(resultId('t.ts::a', 'web', 'buyer')).not.toBe(resultId('t.ts::a', 'web', 'admin'));
    // The first run's id ignores the repeat dimension; later runs get their own.
    expect(resultId('t.ts::a', 'web', 'default', 0)).toBe(resultId('t.ts::a', 'web', 'default'));
    expect(resultId('t.ts::a', 'web', 'default', 1)).toBe(canonicalDigest({ testId: 't.ts::a', targetId: 'web', agent: 'default', repeat: 1 }));
    expect(resultId('t.ts::a', 'web', 'default', 1)).not.toBe(resultId('t.ts::a', 'web', 'default', 2));
  });

  it('pins the bytes: --last-failed matches ids from an earlier report, so a change selects nothing', () => {
    expect(resultId('tests/cart.e2e.ts::checkout::pays', 'web', 'default')).toBe(
      '196879d953095f318e0c3fb8806bf7f9a0b34b076abc4214fcb7fbfaf0fbcf56',
    );
    expect(resultId('tests/cart.e2e.ts::checkout::pays', 'web', 'default', 1)).toBe(
      '327c8053efd3ab636e1049f34c89f7aec511679ff874655c07e047cca174b3a7',
    );
  });
});

describe('uuidv7', () => {
  it('orders by timestamp', () => {
    const earlier = uuidv7(1_000_000);
    const later = uuidv7(2_000_000);
    expect(earlier < later).toBe(true);
  });
});
