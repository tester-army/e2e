import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChangesetFile } from '@changesets/parse';
import { disallowedBumps } from './changeset-bumps.ts';

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
