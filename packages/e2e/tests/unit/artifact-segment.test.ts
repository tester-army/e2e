/**
 * The report path segment a name or test id becomes: a safe alphabet, never
 * `.` or `..` (which would name the directory itself or its parent), a length
 * cap, and a digest of the whole id whenever the alphabet or the cap changed
 * it, so two ids that sanitize alike get artifact directories of their own.
 */

import { describe, expect, it } from 'vitest';
import { sanitizePathSegment } from '../../src/run/artifacts.ts';

const SAFE_ALPHABET = /^[A-Za-z0-9._-]+$/;
const DIGESTED = /-[0-9a-f]{8}$/;
const MAX_SEGMENT_CHARS = 120;

/** A monorepo path, a describe, and a long title: exactly at the cap before the test's own title. */
const PREFIX = 'apps/storefront/tests/checkouts.e2e.ts::checkout::a returning customer with a saved card and an expired coupon on file::';

describe('sanitizePathSegment', () => {
  it('leaves an id that is already safe and within the cap unchanged', () => {
    for (const safe of ['signs-in', 'auth.e2e.ts', 'a_b', '.hidden', 'a..b', 'x'.repeat(MAX_SEGMENT_CHARS)]) {
      expect(sanitizePathSegment(safe)).toBe(safe);
    }
  });

  it('rewrites an id outside the alphabet into it and ends it in a digest of the original', () => {
    const segment = sanitizePathSegment('tests/auth.e2e.ts::auth::signs in');
    expect(segment).toMatch(/^tests_auth\.e2e\.ts__auth__signs_in-[0-9a-f]{8}$/);
    expect(sanitizePathSegment('tests/auth.e2e.ts::auth::signs in')).toBe(segment);
  });

  it('gives two ids that sanitize alike distinct segments', () => {
    const pairs: [string, string][] = [
      ['tests/x.e2e.ts::artifact%20a', 'tests/x.e2e.ts::artifact_20a'],
      ['a b', 'a_b'],
      ['a/b', 'a_b'],
      ['a::b', 'a__b'],
      ['ünïcode', '_n_code'],
      ['a b', 'a/b'],
    ];
    for (const [left, right] of pairs) {
      const segments = [sanitizePathSegment(left), sanitizePathSegment(right)];
      expect(segments[0]).not.toBe(segments[1]);
      for (const segment of segments) expect(segment).toMatch(SAFE_ALPHABET);
    }
  });

  it('never returns the current or parent directory, and tells the dot-only ids apart', () => {
    const segments = ['.', '..', '...'].map((dots) => sanitizePathSegment(dots));
    for (const segment of segments) {
      expect(segment).toMatch(/^_-[0-9a-f]{8}$/);
      expect(segment).not.toBe('_');
    }
    expect(new Set(segments).size).toBe(3);
  });

  it('gives two long ids with a common 120-character prefix distinct, capped segments in the safe alphabet', () => {
    expect(PREFIX).toHaveLength(MAX_SEGMENT_CHARS);
    const first = sanitizePathSegment(`${PREFIX}keeps the coupon after a reload`);
    const second = sanitizePathSegment(`${PREFIX}drops the coupon after sign-out`);

    expect(first).not.toBe(second);
    for (const segment of [first, second]) {
      expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      expect(segment).toMatch(SAFE_ALPHABET);
      expect(segment).toMatch(DIGESTED);
    }
    expect(sanitizePathSegment(`${PREFIX}keeps the coupon after a reload`)).toBe(first);
  });

  it('digests the original id, so two long ids that sanitize alike still differ', () => {
    expect(sanitizePathSegment(`${PREFIX}a b`)).not.toBe(sanitizePathSegment(`${PREFIX}a_b`));
  });

  it('caps a safe 130-character id at 120 with the digest, and a 121-dot id at `_` plus the digest', () => {
    expect(sanitizePathSegment('.'.repeat(121))).toMatch(/^_-[0-9a-f]{8}$/);
    const capped = sanitizePathSegment('a'.repeat(130));
    expect(capped).toHaveLength(MAX_SEGMENT_CHARS);
    expect(capped).toMatch(/^a{111}-[0-9a-f]{8}$/);
  });
});
