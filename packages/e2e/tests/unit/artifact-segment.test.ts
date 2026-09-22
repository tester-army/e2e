/**
 * The report path segment a name or test id becomes: a safe alphabet, never
 * `.` or `..` (which would name the directory itself or its parent), a length
 * cap, and past the cap a digest of the whole id, so two long ids that share
 * a prefix get artifact directories of their own.
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

  it('never returns the current or parent directory, and keeps dots inside a name', () => {
    for (const dots of ['.', '..', '...']) expect(sanitizePathSegment(dots)).toBe('_');
    expect(sanitizePathSegment('.hidden')).toBe('.hidden');
    expect(sanitizePathSegment('a..b')).toBe('a..b');
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

  it('keeps an all-dot id past the cap at `_`, and caps a 130-character id at 120 in the safe alphabet', () => {
    expect(sanitizePathSegment('.'.repeat(121))).toBe('_');
    const capped = sanitizePathSegment('a'.repeat(130));
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped).toMatch(/^[A-Za-z0-9._-]+$/);
    // #423 (oskar/artifact-segment-digest) ends a cut segment in an 8-hex digest of the whole id; before it lands the cut is plain.
    expect(capped).toMatch(capped.includes('-') ? /^a{111}-[0-9a-f]{8}$/ : /^a{120}$/);
  });
});
