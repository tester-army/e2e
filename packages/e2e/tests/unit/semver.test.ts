import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, parseVersion, satisfies } from '../../src/internal/semver.ts';

function version(text: string) {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('parseVersion', () => {
  it.each(['0.21.2', 'v0.21.2', '0.21.3-nightly-20261019081103', '1.0.0-rc.1+build.5'])('reads %s', (text) => {
    expect(parseVersion(text)).toBeDefined();
  });

  it.each(['0.21', '^0.21.2', 'latest', '0.21.2.1', ''])('refuses %s', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });

  it('formats without the v or the build', () => {
    expect(formatVersion(version('v1.2.3-rc.1+abc'))).toBe('1.2.3-rc.1');
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.19.0', '0.20.0', -1],
    ['0.20.0', '0.20.0', 0],
    ['0.10.0', '0.9.9', 1],
    ['0.21.3-nightly-20261018072924', '0.21.3', -1],
    ['0.21.3-nightly-20261018072924', '0.21.3-nightly-20261019081103', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
  ] as const)('%s against %s is %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(version(a), version(b)))).toBe(sign);
  });
});

describe('satisfies', () => {
  it.each([
    ['0.21.2', '>=0.18.0 <1', true],
    ['0.17.9', '>=0.18.0 <1', false],
    ['1.0.0', '>=0.18.0 <1', false],
    ['0.21.2', '0.21.2', true],
    ['0.21.2', '=0.21.2', true],
    ['0.21.3', '0.21.2', false],
    ['0.21.3', '<0.20.0 || >=0.21.0', true],
    ['0.21.3', '>0.21.3', false],
    ['0.21.3', '<=0.21.3', true],
    // A prerelease satisfies only a set that names a prerelease of its own tuple.
    ['0.21.3-nightly-20261019081103', '>=0.15.0 <1', false],
    ['0.21.3-nightly-20261019081103', '0.21.3-nightly-20261019081103', true],
    ['0.21.3-nightly-20261019081103', '0.21.3-nightly-20261018072924', false],
    ['0.21.3-nightly-20261019081103', '>=0.21.3-nightly-20261018072924 <1', true],
    // Outside the grammar: nothing satisfies it.
    ['0.21.2', '^0.21.0', false],
    ['0.21.2', '0.21', false],
    ['0.21.2', '', false],
  ] as const)('%s in %s is %s', (text, range, expected) => {
    expect(satisfies(version(text), range)).toBe(expected);
  });
});
