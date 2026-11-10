import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChangesetFile } from '@changesets/parse';
import {
  announcesFloorRaise,
  disallowedBumps,
  floorRaiseProblems,
  floorRaisesPastMinor,
  latestReleaseVersion,
  nextVersionAfterBump,
  parseVersion,
  pendingBumps,
  type FloorRaiseInput,
} from './changeset-bumps.ts';

const versions = new Map([
  ['e2e', '0.20.0'],
  ['@e2e-dev/web', '0.14.0'],
  ['stable', '1.2.0'],
]);

/** The disallowed bumps of a changeset file with `frontmatter` and `summary`. */
function check(frontmatter: string, summary: string) {
  return disallowedBumps(parseChangesetFile(`---\n${frontmatter}\n---\n\n${summary}\n`), versions);
}

describe('disallowedBumps', () => {
  it('flags a 0.x minor or major with a plain summary', () => {
    assert.deepEqual(check('"e2e": minor\n"@e2e-dev/web": major', 'Adds a thing.'), [
      { name: 'e2e', type: 'minor' },
      { name: '@e2e-dev/web', type: 'major' },
    ]);
  });

  it('lets a breaking change carry a minor but not a major', () => {
    assert.deepEqual(check('"e2e": minor', '**Breaking:** drops `cache.dir`.'), []);
    assert.deepEqual(check('"e2e": major', '**Breaking:** drops `cache.dir`.'), [{ name: 'e2e', type: 'major' }]);
  });

  it('lets a maintainer-called release carry a minor or a major', () => {
    assert.deepEqual(check('"e2e": minor\n"@e2e-dev/web": major', '**Release:** the runner API.'), []);
  });

  it('accepts a patch, a minor of a 1.x package, and an empty changeset', () => {
    assert.deepEqual(check('"e2e": patch\n"stable": minor', 'Adds a thing.'), []);
    assert.deepEqual(disallowedBumps(parseChangesetFile('---\n---\n'), versions), []);
  });
});

describe('floorRaisesPastMinor', () => {
  const released = new Set(['0.18.0', '0.19.0', '0.20.0', '0.21.0', '0.21.3', '0.22.0', '0.23.0']);

  it('flags a raise that cuts off a released version on an older minor', () => {
    assert.equal(floorRaisesPastMinor('0.22.0', '0.23.0', released), true);
    assert.equal(floorRaisesPastMinor('0.18.0', '0.23.0', released), true);
  });

  it('passes a raise within one minor, a lowering, and no change', () => {
    assert.equal(floorRaisesPastMinor('0.22.0', '0.22.1', released), false);
    assert.equal(floorRaisesPastMinor('0.23.0', '0.22.0', released), false);
    assert.equal(floorRaisesPastMinor('0.22.0', '0.22.0', released), false);
  });

  it('passes a correction from a never-published floor to the version it already meant in practice', () => {
    assert.equal(floorRaisesPastMinor('0.22.1', '0.23.0', released), false);
    assert.equal(floorRaisesPastMinor('0.21.4', '0.22.0', released), false);
  });

  it('passes when no released version sits between the floors', () => {
    assert.equal(floorRaisesPastMinor('0.22.0', '0.23.0', new Set(['0.23.0'])), false);
  });
});

describe('announcesFloorRaise', () => {
  it('accepts a breaking minor and a release major, but not a release minor', () => {
    assert.equal(announcesFloorRaise('minor', '**Breaking:** drops old runners.'), true);
    assert.equal(announcesFloorRaise('minor', '**Release:** the runner API.'), false);
    assert.equal(announcesFloorRaise('major', '**Release:** the runner API.'), true);
  });

  it('rejects a patch, a plain minor, and a breaking major', () => {
    assert.equal(announcesFloorRaise('patch', '**Breaking:** drops old runners.'), false);
    assert.equal(announcesFloorRaise('minor', 'Raises the floor.'), false);
    assert.equal(announcesFloorRaise('major', '**Breaking:** drops old runners.'), false);
  });
});

describe('floorRaiseProblems', () => {
  const released = new Set(['0.22.0', '0.23.0']);
  const input = (changes: FloorRaiseInput['changes'], extra: Partial<FloorRaiseInput> = {}): FloorRaiseInput => ({
    name: '@e2e-dev/web',
    path: 'packages/web/package.json',
    peer: 'e2e',
    previousFloor: '0.22.0',
    currentFloor: '0.23.0',
    released,
    changes,
    alreadyFlagged: false,
    ...extra,
  });

  it('fails a floor-raising changeset with a patch bump', () => {
    const problems = floorRaiseProblems([input([{ type: 'patch', summary: 'Fixes a thing.' }])]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /e2e peer floor rises 0\.22\.0 -> 0\.23\.0/);
    assert.match(problems[0]!, /make it a minor whose summary opens \*\*Breaking:\*\*/);
  });

  it('names the highest bump when several changesets touch the package', () => {
    const problems = floorRaiseProblems([
      input([
        { type: 'patch', summary: 'Fixes a thing.' },
        { type: 'patch', summary: 'Fixes another thing.' },
      ]),
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /with only a patch bump/);
  });

  it('fails a floor raise with no changeset at all', () => {
    const problems = floorRaiseProblems([input([])]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /with no changeset for @e2e-dev\/web/);
  });

  it('passes a floor raise carried by a **Breaking:** minor', () => {
    assert.deepEqual(floorRaiseProblems([input([{ type: 'minor', summary: '**Breaking:** needs e2e 0.23.0.' }])]), []);
  });

  it('fails a floor raise carried only by a **Release:** minor', () => {
    const problems = floorRaiseProblems([input([{ type: 'minor', summary: '**Release:** the runner API.' }])]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /make it a minor whose summary opens \*\*Breaking:\*\*/);
  });

  it('passes a correction from a never-published floor on a patch bump', () => {
    assert.deepEqual(
      floorRaiseProblems([input([{ type: 'patch', summary: 'Names the released floor.' }], { previousFloor: '0.22.1' })]),
      [],
    );
  });

  it('leaves an unannounced minor to disallowedBumps instead of reporting it twice', () => {
    assert.deepEqual(
      floorRaiseProblems([input([{ type: 'minor', summary: 'Raises the floor.' }], { alreadyFlagged: true })]),
      [],
    );
  });
});

describe('latestReleaseVersion', () => {
  const tags = ['e2e@0.22.0', 'e2e@0.23.0', 'e2e@0.21.3', '@e2e-dev/web@0.15.5', 'e2e@0.23.0-nightly-1'];

  it('picks the highest released tag for the package', () => {
    assert.equal(latestReleaseVersion(tags, 'e2e'), '0.23.0');
    assert.equal(latestReleaseVersion(tags, '@e2e-dev/web'), '0.15.5');
  });

  it('answers undefined when the package has no released tag', () => {
    assert.equal(latestReleaseVersion(tags, '@e2e-dev/e2b'), undefined);
    assert.equal(latestReleaseVersion([], 'e2e'), undefined);
  });
});

describe('pendingBumps and nextVersionAfterBump', () => {  it('takes the highest bump per package', () => {
    const bumps = pendingBumps([
      parseChangesetFile('---\n"e2e": patch\n---\n\nA fix.\n'),
      parseChangesetFile('---\n"e2e": minor\n"@e2e-dev/web": patch\n---\n\n**Breaking:** a break.\n'),
    ]);
    assert.equal(bumps.get('e2e'), 'minor');
    assert.equal(bumps.get('@e2e-dev/web'), 'patch');
  });

  it('bumps versions the way changesets does', () => {
    assert.equal(nextVersionAfterBump('0.23.0', 'patch'), '0.23.1');
    assert.equal(nextVersionAfterBump('0.23.0', 'minor'), '0.24.0');
    assert.equal(nextVersionAfterBump('0.23.0', 'major'), '1.0.0');
    assert.equal(nextVersionAfterBump('not semver', 'patch'), undefined);
    assert.deepEqual(parseVersion('0.23.0'), [0, 23, 0]);
    assert.equal(parseVersion('0.23.0-canary-x'), undefined);
  });
});
