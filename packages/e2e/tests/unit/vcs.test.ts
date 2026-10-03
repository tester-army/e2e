import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectVcs } from '../../src/internal/vcs.ts';
import { initRepo, runGit } from '../helpers/git-repo.ts';

const SHA = 'a'.repeat(40);
const outside = mkdtempSync(path.join(os.tmpdir(), 'e2e-vcs-'));

afterAll(() => rmSync(outside, { recursive: true, force: true }));

describe('detectVcs', () => {
  it('reads the commit and branch of a git checkout over CI, says whether it is dirty, and names no branch on a detached HEAD', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'e2e-vcs-repo-'));
    try {
      const commit = initRepo(repo);
      runGit(repo, 'switch', '--quiet', '-c', 'feature');
      expect(await detectVcs(repo, { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main' })).toEqual({ commit, branch: 'feature', dirty: false });
      writeFileSync(path.join(repo, 'file.txt'), 'two\n');
      expect(await detectVcs(repo, {})).toEqual({ commit, branch: 'feature', dirty: true });
      runGit(repo, 'switch', '--quiet', '--detach');
      expect(await detectVcs(repo, {})).toEqual({ commit, dirty: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls back to the CI variables outside git', async () => {
    expect(await detectVcs(outside, { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main' })).toEqual({
      commit: SHA,
      branch: 'main',
    });
    // A pull request run names the head branch, not the merge ref.
    expect(
      await detectVcs(outside, { GITHUB_SHA: SHA, GITHUB_HEAD_REF: 'feature', GITHUB_REF_NAME: '12/merge' }),
    ).toEqual({ commit: SHA, branch: 'feature' });
  });

  it('records nothing when neither git nor CI knows the commit', async () => {
    expect(await detectVcs(outside, {})).toBeUndefined();
    expect(await detectVcs(outside, { GITHUB_SHA: 'not-a-sha' })).toBeUndefined();
  });
});
