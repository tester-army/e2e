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
});
