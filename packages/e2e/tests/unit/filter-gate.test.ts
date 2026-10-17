/**
 * The gate in front of the test filters, on real throwaway git
 * repositories: a `--last-failed` rerun and an empty selection never ask
 * git, no change calls no filter, a lockfile or the config file changing
 * runs every test, and a test whose file, stored screenshots, or session's
 * setup file changed runs without filters.
 */

import { existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateTestFilters, type FilterGateInput } from '../../src/run/filter-gate.ts';
import type { TestFilterCandidate } from '../../src/types.ts';
import { commitFiles, initRepo, runGit, useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();

/** Whether the temp directory's filesystem ignores case, as default macOS and Windows do. */
const CASE_INSENSITIVE = existsSync(os.tmpdir().toUpperCase()) && existsSync(os.tmpdir().toLowerCase());

/** A candidate for the one test in project-relative `file`, whose session `setupFile` saves when given. */
function candidate(file: string, setupFile?: string): TestFilterCandidate {
  return { id: `${file}::t`, file, titlePath: ['t'], tags: [], ...(setupFile === undefined ? {} : { setupFile }) };
}

const CANDIDATES = [candidate('tests/a.e2e.ts'), candidate('tests/b.e2e.ts'), candidate('tests/c.e2e.ts')];

/**
 * A repository with the project in `app/`, its config and three test files
 * committed on `main`, and a branch checked out that commits `files`.
 */
function projectRepo(files: Readonly<Record<string, string>>) {
  const root = tempDir();
  initRepo(root);
  const base = commitFiles(root, {
    'app/e2e.config.ts': 'export default {};\n',
    'app/tests/a.e2e.ts': 'a\n',
    'app/tests/b.e2e.ts': 'b\n',
    'app/tests/c.e2e.ts': 'c\n',
    'app/src/app.ts': 'one\n',
  });
  runGit(root, 'checkout', '--quiet', '-b', 'feature');
  commitFiles(root, files);
  return { root, base, projectRoot: path.join(root, 'app') };
}

/** Runs the gate on `input` over a run with all three candidates and no session, no flag, and no CI, recording its notices. */
async function gate(input: Partial<FilterGateInput> & Pick<FilterGateInput, 'projectRoot'>) {
  const notices: string[] = [];
  const decided = await gateTestFilters({
    candidates: CANDIDATES,
    lastFailed: false,
    changedSince: undefined,
    configPath: undefined,
    env: {},
    signal: new AbortController().signal,
    notice: (message) => notices.push(message),
    ...input,
  });
  return { ...decided, notices };
}

/**
 * Hands the gate the project root as `spell` writes it from the
 * repository root, and expects a changed test file still pinned and a
 * changed config file still running every test.
 */
async function expectSpelledRootMatched(spell: (root: string) => string): Promise<void> {
  const changed = projectRepo({ 'app/tests/b.e2e.ts': 'b2\n' });
  const decided = await gate({ projectRoot: spell(changed.root), changedSince: 'main' });
  expect(decided.candidates).toEqual([CANDIDATES[0], CANDIDATES[2]]);
  expect(decided.record).toEqual({ base: changed.base, files: 1, pinned: 1 });

  const edited = projectRepo({ 'app/e2e.config.ts': 'export default { changed: true };\n' });
  const projectRoot = spell(edited.root);
  const configPath = path.join(projectRoot, 'e2e.config.ts');
  expect(await gate({ projectRoot, changedSince: 'main', configPath })).toMatchObject({
    changes: undefined,
    record: { base: edited.base, files: 1, skipped: 'app/e2e.config.ts changed' },
  });
}

describe('gateTestFilters', () => {
  it('never judges a --last-failed rerun, and asks no git for it', async () => {
    const outside = tempDir();
    const decided = await gate({ projectRoot: outside, lastFailed: true, changedSince: 'main' });
    expect(decided).toEqual({
      candidates: [],
      changes: undefined,
      record: { files: 0, skipped: '--last-failed' },
      notices: ['--last-failed: the tests the last run owes run without filters'],
    });
  });

  it('calls no filter with no test to judge, asking no git', async () => {
    const decided = await gate({ projectRoot: tempDir(), candidates: [], changedSince: 'main' });
    expect(decided).toMatchObject({ candidates: [], changes: undefined, record: { files: 0, skipped: 'no tests to judge' }, notices: ['no tests to judge, so no filter ran'] });
  });

  it('calls no filter without a change, and warns when a pull request cannot be measured', async () => {
    const { projectRoot } = projectRepo({ 'app/src/app.ts': 'two\n' });
    const missing = 'f'.repeat(40);
    const env = { GITLAB_CI: 'true', CI_MERGE_REQUEST_DIFF_BASE_SHA: missing };
    const reason = "could not find the merge request's base commit fffffff in the checkout: fetch more history with GIT_DEPTH: 0";
    expect(await gate({ projectRoot, env })).toMatchObject({ changes: undefined, record: { files: 0, skipped: reason }, notices: [`warning: no filter ran: ${reason}`] });

    const decided = await gate({ projectRoot, changedSince: 'HEAD' });
    const head = runGit(projectRoot, 'rev-parse', 'HEAD');
    expect(decided).toMatchObject({ changes: undefined, record: { base: head, files: 0, skipped: `no files changed since ${head.slice(0, 7)}` } });
  });

  it('judges the change, handing the filters every candidate whose file did not change', async () => {
    const { root, base, projectRoot } = projectRepo({ 'app/src/app.ts': 'two\n', 'README.md': 'docs\n' });
    const decided = await gate({ projectRoot, changedSince: 'main', configPath: path.join(projectRoot, 'e2e.config.ts') });
    expect(decided.candidates).toEqual(CANDIDATES);
    expect(decided.changes).toMatchObject({ base, files: ['README.md', 'app/src/app.ts'] });
    expect(decided.changes?.root).toBe(runGit(root, 'rev-parse', '--show-toplevel'));
    expect(decided.record).toEqual({ base, files: 2 });
    expect(decided.notices).toEqual([`judging 2 files changed since ${base.slice(0, 7)}`]);
  });

  it('runs a test whose file changed without filters, mapping project paths into the repository', async () => {
    const { base, projectRoot } = projectRepo({ 'app/tests/b.e2e.ts': 'b2\n', 'app/src/app.ts': 'two\n' });
    const decided = await gate({ projectRoot, changedSince: 'main' });
    expect(decided.candidates.map((entry) => entry.file)).toEqual(['tests/a.e2e.ts', 'tests/c.e2e.ts']);
    expect(decided.record).toEqual({ base, files: 2, pinned: 1 });
    expect(decided.notices).toEqual([`judging 2 files changed since ${base.slice(0, 7)}`, '1 test runs without filters: its test file, screenshots, or setup file changed']);
  });

  it('runs a test whose session a changed setup file saves without filters, mapping the setup file as it maps a test file', async () => {
    // macOS keeps the bytes a file was created with, while git there names every file in NFC: committed composed, collected decomposed.
    const composed = 'tests/caf\u00E9.setup.e2e.ts';
    const decomposed = 'tests/cafe\u0301.setup.e2e.ts';
    const { base, projectRoot } = projectRepo({ 'app/tests/auth.setup.e2e.ts': 'setup2\n', [`app/${composed}`]: 's\n', 'app/src/app.ts': 'two\n' });
    const candidates = [
      candidate('tests/a.e2e.ts', 'tests/auth.setup.e2e.ts'),
      candidate('tests/b.e2e.ts', decomposed),
      candidate('tests/c.e2e.ts', 'tests/other.setup.e2e.ts'),
    ];
    const decided = await gate({ projectRoot, changedSince: 'main', candidates });
    expect(decided.candidates).toEqual([candidates[2]]);
    expect(decided.record).toEqual({ base, files: 3, pinned: 2 });
    expect(decided.notices).toEqual([`judging 3 files changed since ${base.slice(0, 7)}`, '2 tests run without filters: their test file, screenshots, or setup file changed']);
  });

  it("runs a test whose stored screenshots, or its setup file's, changed without filters, never another file's", async () => {
    const { base, projectRoot } = projectRepo({
      'app/tests/a.e2e.ts-snapshots/home-darwin.png': 'png\n',
      'app/tests/auth.setup.e2e.ts-snapshots/signed-in.png': 'png\n',
      'app/tests/c.e2e.tsx-snapshots/home.png': 'png\n',
    });
    const candidates = [CANDIDATES[0]!, candidate('tests/b.e2e.ts', 'tests/auth.setup.e2e.ts'), CANDIDATES[2]!];
    const decided = await gate({ projectRoot, changedSince: 'main', candidates });
    expect(decided.candidates).toEqual([CANDIDATES[2]]);
    expect(decided.record).toEqual({ base, files: 3, pinned: 2 });
  });

  it('pins a changed test file and spots a config change through a symlinked project path', async () => {
    await expectSpelledRootMatched((root) => {
      const link = path.join(tempDir(), 'link');
      symlinkSync(root, link);
      return path.join(link, 'app');
    });
  });

  it.runIf(CASE_INSENSITIVE)('pins a changed test file and spots a config change when the project root is typed in another case', async () => {
    await expectSpelledRootMatched((root) => path.join(root, 'APP'));
  });

  it('calls no filter once every test file changed', async () => {
    const { base, projectRoot } = projectRepo({ 'app/tests/a.e2e.ts': 'a2\n', 'app/tests/b.e2e.ts': 'b2\n', 'app/tests/c.e2e.ts': '' });
    const decided = await gate({ projectRoot, changedSince: 'main' });
    expect(decided).toMatchObject({
      candidates: [],
      changes: undefined,
      record: { base, files: 3, pinned: 3, skipped: 'no tests left to judge' },
      notices: ['3 tests run without filters: their test file, screenshots, or setup file changed', 'no tests left to judge, so no filter ran'],
    });
  });

  it('runs every test when a lockfile of any package manager at any depth changed, never for a config file it did not load or a file named like a lockfile', async () => {
    const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'app/packages/ui/pnpm-lock.yaml', 'app/ios/Podfile.lock', 'android/gradle.lockfile', 'Gemfile.lock', 'go.sum', 'Cargo.lock'];
    for (const lockfile of lockfiles) {
      const { base, projectRoot } = projectRepo({ [lockfile]: 'lock\n', 'app/src/app.ts': 'two\n' });
      const decided = await gate({ projectRoot, changedSince: 'main' });
      expect(decided, lockfile).toMatchObject({ candidates: [], changes: undefined, record: { base, files: 2, skipped: `${lockfile} changed` }, notices: [`${lockfile} changed, so no filter ran`] });
    }

    const { projectRoot } = projectRepo({ 'app/e2e.config.ts': 'export default { changed: true };\n' });
    // A config value has no file to change: the edit is an ordinary file.
    expect((await gate({ projectRoot, changedSince: 'main' })).changes?.files).toEqual(['app/e2e.config.ts']);
    // A file merely named like a lockfile is not one.
    const named = projectRepo({ 'app/docs/pnpm-lock.yaml.md': 'about locks\n' });
    expect((await gate({ projectRoot: named.projectRoot, changedSince: 'main' })).changes?.files).toEqual(['app/docs/pnpm-lock.yaml.md']);
  });
});
