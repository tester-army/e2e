import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { detectVcs } from '../../src/internal/vcs.ts';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SHA = 'a'.repeat(40);
const outside = mkdtempSync(path.join(os.tmpdir(), 'e2e-vcs-'));

afterAll(() => rmSync(outside, { recursive: true, force: true }));

describe('detectVcs', () => {
  it('reads the commit of a git checkout and says whether it is dirty', async () => {
    const info = await detectVcs(REPO_ROOT, {});
    expect(info?.commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(typeof info?.dirty).toBe('boolean');
    if (info?.branch !== undefined) expect(info.branch).not.toBe('HEAD');
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
