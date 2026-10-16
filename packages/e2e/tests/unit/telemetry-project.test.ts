/** The anonymous project id: a hashed root commit in a full clone, nothing everywhere else. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/internal/ids.ts';
import { anonymousProjectId } from '../../src/telemetry/project.ts';
import { initRepo, runGit } from '../helpers/git-repo.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-telemetry-project-'));
const repo = path.join(dir, 'repo');
mkdirSync(repo);
const root = initRepo(repo);
writeFileSync(path.join(repo, 'file.txt'), 'two\n');
runGit(repo, 'commit', '--quiet', '-am', 'two');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('anonymousProjectId', () => {
  it('hashes the root commit, which every clone shares, and never sends the commit itself', async () => {
    const id = await anonymousProjectId(repo);
    expect(id).toBe(sha256Hex(`git\n${root}`));
    expect(id).not.toContain(root);
    mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    expect(await anonymousProjectId(path.join(repo, 'packages', 'app'))).toBe(id);
  });

  it('has no id outside git or in a shallow clone, whose roots move with every fetch', async () => {
    const shallow = path.join(dir, 'shallow');
    runGit(dir, 'clone', '--quiet', '--depth', '1', pathToFileURL(repo).href, shallow);
    expect(await anonymousProjectId(shallow)).toBeUndefined();
    const plain = path.join(dir, 'plain');
    mkdirSync(plain);
    expect(await anonymousProjectId(plain)).toBeUndefined();
  });
});
