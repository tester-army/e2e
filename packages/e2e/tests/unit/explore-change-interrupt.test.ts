/**
 * An interrupt that lands once the change is measured, while the brief is
 * read: the read stops with `INTERRUPTED`, as an interrupt of the run does.
 */

import { describe, expect, it, vi } from 'vitest';
import { commitFiles, initRepo, runGit, useTempDirs } from '../helpers/git-repo.ts';

const interrupt = new AbortController();

vi.mock('../../src/run/changes.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/run/changes.ts')>();
  return {
    ...actual,
    findChanges: async (options: Parameters<typeof actual.findChanges>[0]) => {
      const changes = await actual.findChanges(options);
      interrupt.abort();
      return changes;
    },
  };
});

const { readExploreChange } = await import('../../src/explore/change.ts');
const tempDir = useTempDirs();

describe('readExploreChange interrupted while reading the brief', () => {
  it('is INTERRUPTED', async () => {
    const dir = tempDir();
    initRepo(dir);
    runGit(dir, 'branch', 'base');
    commitFiles(dir, { 'a.txt': 'a\n' }, 'add');
    await expect(readExploreChange({ cwd: dir, changedSince: 'base', signal: interrupt.signal })).rejects.toMatchObject({
      code: 'INTERRUPTED',
      message: expect.stringContaining('reading the change to explore'),
    });
  });
});
