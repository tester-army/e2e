/**
 * The report path segment a name or test id becomes: a safe alphabet, and
 * never `.` or `..`, which would name the directory itself or its parent.
 */

import { describe, expect, it } from 'vitest';
import { sanitizePathSegment } from '../../src/run/artifacts.ts';

describe('sanitizePathSegment', () => {
  it('maps a test id to the safe alphabet', () => {
    expect(sanitizePathSegment('tests/auth.e2e.ts::auth::signs in')).toBe('tests_auth.e2e.ts__auth__signs_in');
  });

  it('never returns the current or parent directory, and keeps dots inside a name', () => {
    for (const dots of ['.', '..', '...']) expect(sanitizePathSegment(dots)).toBe('_');
    expect(sanitizePathSegment('.hidden')).toBe('.hidden');
    expect(sanitizePathSegment('a..b')).toBe('a..b');
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
