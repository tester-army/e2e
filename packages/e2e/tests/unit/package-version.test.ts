import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../../src/internal/package-version.ts';

describe('packageVersion', () => {
  it('reads the version of a resolvable package.json (mirrors the playwright driver manifest)', () => {
    const expected = (
      createRequire(import.meta.url)('playwright/package.json') as { version: string }
    ).version;
    const version = packageVersion(import.meta.url, 'playwright/package.json', '0.0.0');
    expect(version).toBe(expected);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reads a relative package.json specifier (mirrors report/build.ts)', () => {
    const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
    expect(version).toBe(
      (createRequire(import.meta.url)('../../package.json') as { version: string }).version,
    );
  });

  it('returns the fallback when the specifier cannot be resolved', () => {
    expect(
      packageVersion(import.meta.url, 'definitely-not-a-real-package/package.json', '9.9.9'),
    ).toBe('9.9.9');
  });

  it('returns the fallback when the base URL is unusable', () => {
    expect(packageVersion('not-a-url', 'commander/package.json', 'fallback')).toBe('fallback');
  });
});
