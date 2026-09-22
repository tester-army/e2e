/**
 * The report path segment a test id becomes: a safe alphabet, a length cap,
 * and past the cap a digest of the whole id, so two long ids that share a
 * prefix get artifact directories of their own.
 */

import { describe, expect, it } from 'vitest';
import { sanitizePathSegment } from '../../src/run/artifacts.ts';

const SAFE_ALPHABET = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENT_CHARS = 120;

/** A monorepo path, a describe, and a long title: exactly at the cap before the test's own title. */
const PREFIX = 'apps/storefront/tests/checkouts.e2e.ts::checkout::a returning customer with a saved card and an expired coupon on file::';

describe('sanitizePathSegment', () => {
  it('maps an id within the cap to the same segment as before', () => {
    expect(sanitizePathSegment('tests/auth.e2e.ts::auth::signs in')).toBe('tests_auth.e2e.ts__auth__signs_in');
    const atCap = 'x'.repeat(MAX_SEGMENT_CHARS);
    expect(sanitizePathSegment(atCap)).toBe(atCap);
  });

  it('gives two long ids with a common 120-character prefix distinct, capped segments in the safe alphabet', () => {
    expect(PREFIX).toHaveLength(MAX_SEGMENT_CHARS);
    const first = sanitizePathSegment(`${PREFIX}keeps the coupon after a reload`);
    const second = sanitizePathSegment(`${PREFIX}drops the coupon after sign-out`);

    expect(first).not.toBe(second);
    for (const segment of [first, second]) {
      expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      expect(segment).toMatch(SAFE_ALPHABET);
      expect(segment).toMatch(/-[0-9a-f]{8}$/);
    }
    expect(sanitizePathSegment(`${PREFIX}keeps the coupon after a reload`)).toBe(first);
  });

  it('digests the original id, so two long ids that sanitize alike still differ', () => {
    expect(sanitizePathSegment(`${PREFIX}a b`)).not.toBe(sanitizePathSegment(`${PREFIX}a_b`));
  });
});
