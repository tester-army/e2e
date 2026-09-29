/**
 * The report path segment a name or test id becomes: a safe alphabet, never
 * `.` or `..` (which would name the directory itself or its parent), a length
 * cap, and a digest of the whole id whenever the alphabet or the cap changed
 * it, so two ids that sanitize alike get artifact directories of their own.
 */

import { describe, expect, it } from 'vitest';
import { labelSegment, sanitizePathSegment } from '../../src/run/artifacts.ts';

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

describe('labelSegment', () => {
  const GOAL = 'Starting at /e/cart-totals, change each quantity up and down; check every total and the tax line';

  it('names an exploration by the first words of its goal and a digest of the whole goal', () => {
    expect(labelSegment('explore', GOAL)).toBe('explore-starting-at-e-cart-totals-change-05548d832bd70a7a');
    expect(labelSegment('explore', GOAL)).toBe(labelSegment('explore', GOAL));
  });

  it('keeps two goals with the same first words apart', () => {
    const first = labelSegment('explore', 'Check the cart totals after changing quantities');
    const second = labelSegment('explore', 'Check the cart totals after removing an item');
    expect(first).toBe('explore-check-the-cart-totals-after-948a4f2f323d43b8');
    expect(second).toBe('explore-check-the-cart-totals-after-8821956513c7ae54');
  });

  it('keeps apart two goals whose first 32 digest bits collide', () => {
    const first = labelSegment('explore', 'Check the cart totals after changing quantities 5885');
    const second = labelSegment('explore', 'Check the cart totals after changing quantities 62140');
    expect(first).toBe('explore-check-the-cart-totals-after-5846d49d844ea116');
    expect(second).toBe('explore-check-the-cart-totals-after-5846d49df03de864');
  });

  it('leaves out a first word the prefix already says', () => {
    expect(labelSegment('explore', 'Explore the app and find bugs')).toBe('explore-the-app-and-find-bugs-f705c04163ee21e6');
    expect(labelSegment('explore', 'Explore')).toMatch(/^explore-[0-9a-f]{16}$/);
  });

  it('drops accents, falls back to the digest alone, and cuts one long word, always a safe segment', () => {
    const segments = [
      labelSegment('explore', 'Sprawdź koszyk: żółć, Łódź'),
      labelSegment('explore', '購入フローを確認する'),
      labelSegment('explore', `${'x'.repeat(300)} and more`),
      labelSegment('explore', '../../etc/passwd'),
    ];
    expect(segments[0]).toMatch(/^explore-sprawdz-koszyk-zolc-lodz-[0-9a-f]{16}$/);
    expect(segments[1]).toMatch(/^explore-[0-9a-f]{16}$/);
    expect(segments[2]).toMatch(/^explore-x{32}-[0-9a-f]{16}$/);
    expect(segments[3]).toMatch(/^explore-etc-passwd-[0-9a-f]{16}$/);
    for (const segment of segments) expect(sanitizePathSegment(segment)).toBe(segment);
  });
});
