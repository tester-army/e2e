import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { packageVersion, readJson } from '../../src/internal/package-version.ts';

describe('packageVersion', () => {
  it('reads the version of a resolvable package.json (mirrors a driver manifest)', () => {
    const expected = (
      createRequire(import.meta.url)('zod/package.json') as { version: string }
    ).version;
    const version = packageVersion(import.meta.url, 'zod/package.json', '0.0.0');
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
    expect(packageVersion('not-a-url', 'zod/package.json', 'fallback')).toBe('fallback');
  });
});

describe('readJson', () => {
  it('reads a resolvable JSON module', () => {
    expect(readJson(import.meta.url, '../../package.json')).toMatchObject({ name: 'e2e' });
  });

  it('returns undefined when the specifier cannot be resolved', () => {
    expect(readJson(import.meta.url, './definitely-missing.json')).toBeUndefined();
  });
});
