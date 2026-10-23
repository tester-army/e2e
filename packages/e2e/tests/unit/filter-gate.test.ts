/**
 * The gate in front of the test filters, on real throwaway git
 * repositories: a `--last-failed` rerun and an empty selection never ask
 * git, no change calls no filter, and any other change is judged by every
 * filter, on every test.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateTestFilters, type FilterGateInput } from '../../src/run/filter-gate.ts';
import type { TestFilterCandidate } from '../../src/types.ts';
import { commitFiles, initRepo, runGit, useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();

/** A candidate for the one test in project-relative `file`. */
function candidate(file: string): TestFilterCandidate {
  return { id: `${file}::t`, file, titlePath: ['t'], tags: [] };
}

const CANDIDATES = [candidate('tests/a.e2e.ts'), candidate('tests/b.e2e.ts')];

/** A repository with the project in `app/`, its config and two test files committed on `main`, and a branch checked out that commits `files`. */
function projectRepo(files: Readonly<Record<string, string>>) {
  const root = tempDir();
  initRepo(root);
  const base = commitFiles(root, {
    'app/e2e.config.ts': 'export default {};\n',
    'app/tests/a.e2e.ts': 'a\n',
    'app/tests/b.e2e.ts': 'b\n',
    'app/src/app.ts': 'one\n',
  });
  runGit(root, 'checkout', '--quiet', '-b', 'feature');
  commitFiles(root, files);
  return { root, base, projectRoot: path.join(root, 'app') };
}

/** Runs the gate on `input` over a run with both candidates, judging the change since `main`, recording its notices. */
async function gate(input: Partial<FilterGateInput> & Pick<FilterGateInput, 'projectRoot'>) {
  const notices: string[] = [];
  const decided = await gateTestFilters({
    candidates: CANDIDATES,
    lastFailed: false,
    changedSince: 'main',
    signal: new AbortController().signal,
    notice: (message) => notices.push(message),
    ...input,
  });
  return { ...decided, notices };
}

describe('gateTestFilters', () => {
  it('never judges a --last-failed rerun, and asks no git for it', async () => {
    const decided = await gate({ projectRoot: tempDir(), lastFailed: true });
    expect(decided).toEqual({
      kind: 'skip',
      record: { skipped: '--last-failed' },
      notices: ['--last-failed: the tests the last run owes run without filters'],
    });
  });

  it('calls no filter with no test to judge, asking no git', async () => {
    const decided = await gate({ projectRoot: tempDir(), candidates: [] });
    expect(decided).toEqual({ kind: 'skip', record: { skipped: 'no tests to judge' }, notices: ['no tests to judge, so no filter ran'] });
  });

  it('calls no filter with no file changed since the ref', async () => {
    const { projectRoot } = projectRepo({ 'app/src/app.ts': 'two\n' });
    const decided = await gate({ projectRoot, changedSince: 'HEAD' });
    const head = runGit(projectRoot, 'rev-parse', 'HEAD');
    const reason = `no files changed since ${head.slice(0, 7)}`;
    expect(decided).toEqual({ kind: 'skip', record: { base: head, files: 0, skipped: reason }, notices: [`${reason}, so no filter ran`] });
  });

  it('judges any change, a test file, the config, or a lockfile among it, from the repository root', async () => {
    const { root, base, projectRoot } = projectRepo({ 'app/src/app.ts': 'two\n', 'app/tests/b.e2e.ts': 'b2\n', 'app/e2e.config.ts': 'export default { a: 1 };\n', 'pnpm-lock.yaml': 'lock\n' });
    const decided = await gate({ projectRoot });
    if (decided.kind !== 'judge') throw new Error(`expected the gate to judge, got ${JSON.stringify(decided.record)}`);
    expect(decided.changes).toMatchObject({ base, files: ['app/e2e.config.ts', 'app/src/app.ts', 'app/tests/b.e2e.ts', 'pnpm-lock.yaml'] });
    expect(decided.changes.root).toBe(runGit(root, 'rev-parse', '--show-toplevel'));
    expect(decided.record).toEqual({ base, files: 4 });
    expect(decided.notices).toEqual([`judging 4 files changed since ${base.slice(0, 7)}`]);
  });

});
