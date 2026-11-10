import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { publicPackages } from './public-packages.ts';
import { peerFloor, peerRangeProblems, releasedVersions, type PublicPackage } from './peer-ranges.ts';

function pkg(name: string, peers: Record<string, string>): PublicPackage {
  return { path: `/repo/packages/${name}/package.json`, manifest: { name, version: '0.1.0', peerDependencies: peers } };
}

describe('peerFloor', () => {
  it('reads the floor of a wide range', () => {
    assert.equal(peerFloor('>=0.15.0 <1'), '0.15.0');
    assert.equal(peerFloor('>=1.2.3 <2'), '1.2.3');
  });

  it('answers undefined for any other shape', () => {
    assert.equal(peerFloor('^0.15.0'), undefined);
    assert.equal(peerFloor('0.15.0'), undefined);
    assert.equal(peerFloor('>=0.15.0'), undefined);
  });
});

describe('releasedVersions', () => {
  it('reads released versions from changelog headings only', () => {
    const versions = releasedVersions('# Changelog\n\n## 0.23.0\n\n- a fix\n\n## 0.22.0\n\nSee ## 0.21.0 in the text, not a heading.\n');
    assert.deepEqual([...versions].toSorted(), ['0.22.0', '0.23.0']);
  });

  it('answers an empty set for a changelog with no releases', () => {
    assert.equal(releasedVersions('# Changelog\n').size, 0);
  });
});

describe('peerRangeProblems', () => {
  const changelog = '## 0.15.0\n\n## 0.18.0\n';
  const read = () => changelog;

  it('passes a wide range on a released floor', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.18.0 <1' })];
    assert.deepEqual(peerRangeProblems(packages, read), []);
  });

  it('fails a wide range on a floor the sibling never released', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.22.1 <1' })];
    const problems = peerRangeProblems(packages, read);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /floor is 0\.22\.1, which e2e never released/);
  });

  it('passes a floor that is the sibling version a pending changeset releases', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.19.0 <1' })];
    assert.deepEqual(peerRangeProblems(packages, read, new Map([['e2e', '0.19.0']])), []);
  });

  it('still fails a floor past the sibling version a pending changeset releases', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.20.0 <1' })];
    const problems = peerRangeProblems(packages, read, new Map([['e2e', '0.19.0']]));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /floor is 0\.20\.0, which e2e never released/);
  });

  it('fails a range that is not a wide range', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '^0.18.0' })];
    const problems = peerRangeProblems(packages, read);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /expected >=<major\.minor\.patch> <major\+1>/);
  });

  it('fails when the sibling has no changelog to show the floor released', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.18.0 <1' })];
    const problems = peerRangeProblems(packages, () => undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /has no CHANGELOG\.md/);
  });

  it('passes a floor that is the pending version of a sibling with no changelog yet', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.1.0 <1' })];
    assert.deepEqual(peerRangeProblems(packages, () => undefined, new Map([['e2e', '0.1.0']])), []);
  });

  it('still fails a floor past the pending version of a sibling with no changelog', () => {
    const packages = [pkg('e2e', {}), pkg('@e2e-dev/web', { e2e: '>=0.18.0 <1' })];
    const problems = peerRangeProblems(packages, () => undefined, new Map([['e2e', '0.2.0']]));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /has no CHANGELOG\.md/);
  });

  it('ignores peers that are not siblings', () => {
    const packages = [pkg('@e2e-dev/web', { e2e: '>=9.9.9 <1', zod: '^3.0.0' })];
    assert.deepEqual(peerRangeProblems(packages, read), []);
  });
});

describe('released floors on this repo', () => {
  it('has no sibling peer floor naming a version that never shipped (#1657)', () => {
    const problems = peerRangeProblems(publicPackages(), (packagePath) => {
      try {
        return readFileSync(join(dirname(packagePath), 'CHANGELOG.md'), 'utf8');
      } catch {
        return undefined;
      }
    });
    assert.deepEqual(problems, []);
  });

  it('keeps the #1657 floors at the oldest released sibling each package works with', () => {
    const byName = new Map(publicPackages().map(({ manifest }) => [manifest.name, manifest.peerDependencies ?? {}]));
    assert.equal(byName.get('@e2e-dev/mobile')?.['e2e'], '>=0.23.0 <1');
    assert.equal(byName.get('@e2e-dev/web')?.['e2e'], '>=0.23.0 <1');
    assert.equal(byName.get('@e2e-dev/acp')?.['e2e'], '>=0.22.0 <1');
    assert.equal(byName.get('@e2e-dev/limrun')?.['@e2e-dev/mobile'], '>=0.11.0 <1');
  });
});
