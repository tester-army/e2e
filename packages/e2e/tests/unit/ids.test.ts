import { describe, expect, it } from 'vitest';
import {
  canonicalDigest,
  canonicalJson,
  encodeTitle,
  resultId,
  setupTestId,
  testId,
  timestamp,
  uuidv7,
  validateTitle,
} from '../../src/internal/ids.ts';

describe('encodeTitle', () => {
  it('keeps RFC 3986 unreserved characters literal', () => {
    expect(encodeTitle('abcXYZ019-._~')).toBe('abcXYZ019-._~');
  });

  it('percent-encodes every other byte as uppercase %HH', () => {
    expect(encodeTitle('a b')).toBe('a%20b');
    expect(encodeTitle('a/b')).toBe('a%2Fb');
    expect(encodeTitle('a%b')).toBe('a%25b');
    expect(encodeTitle('a:b')).toBe('a%3Ab');
  });

  it('encodes UTF-8 bytes of non-ASCII characters', () => {
    expect(encodeTitle('ż')).toBe('%C5%BC');
    expect(encodeTitle('日')).toBe('%E6%97%A5');
  });

  it('applies NFC normalization before encoding', () => {
    const decomposed = 'e\u0301'; // e + combining acute
    expect(encodeTitle(decomposed)).toBe('%C3%A9');
  });
});

describe('validateTitle', () => {
  it('rejects empty titles', () => {
    expect(validateTitle('')).not.toBeNull();
  });

  it('rejects titles over 512 UTF-8 bytes', () => {
    expect(validateTitle('ż'.repeat(257))).not.toBeNull();
    expect(validateTitle('a'.repeat(512))).toBeNull();
  });

  it('rejects NUL', () => {
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

  it('prefixes setup IDs', () => {
    expect(setupTestId('t.ts', ['auth'])).toBe('setup::t.ts::auth');
  });
});

describe('canonicalJson (RFC 8785)', () => {
  it('sorts object keys by UTF-16 code units', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('serializes nested structures deterministically', () => {
    expect(canonicalJson({ z: [1, 'x', null], a: { c: true, b: false } })).toBe(
      '{"a":{"b":false,"c":true},"z":[1,"x",null]}',
    );
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
});

describe('uuidv7', () => {
  it('produces lowercase UUIDs with version 7 and RFC variant', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('orders by timestamp', () => {
    const earlier = uuidv7(1_000_000);
    const later = uuidv7(2_000_000);
    expect(earlier < later).toBe(true);
  });
});

describe('timestamp', () => {
  it('is RFC 3339 UTC with millisecond precision', () => {
    expect(timestamp(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });
});
