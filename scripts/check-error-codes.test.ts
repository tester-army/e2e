import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { sourceRoots } from './error-codes.ts';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

/** A published package's project-relative directory, with `/` separators. */
function packageDir(manifestPath: string): string {
  return relative(REPO_ROOT, dirname(manifestPath)).split('\\').join('/');
}

describe('sourceRoots', () => {
  it('scans the src directory of every published package, so a new one is never forgotten', () => {
    const expected = publicPackages()
      .map(({ path }) => `${packageDir(path)}/src`)
      .filter((dir) => existsSync(join(REPO_ROOT, dir)))
      .toSorted();
    assert.deepEqual(sourceRoots(), expected);
  });

  it('includes the integration packages whose codes the reference must document', () => {
    const roots = sourceRoots();
    // Regression: these were missing while the list was hand-kept.
    assert.ok(roots.includes('packages/eas/src'), `expected packages/eas/src in ${roots.join(', ')}`);
    assert.ok(roots.includes('packages/smol/src'), `expected packages/smol/src in ${roots.join(', ')}`);
  });
});
