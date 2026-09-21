/**
 * A test's reported source is where the test file declared it. The runner
 * reads it off a stack whose frames for its own code, once source-mapped,
 * point at `src/` while the running module lives in `dist/`; those frames must
 * never win, and neither may a project helper that wraps `test()`. The built
 * CLI is spawned because a vitest fork reports raw transformed positions,
 * while a plain Node process maps them as users see.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { Report } from '../../src/index.ts';
import { createProject } from '../helpers/run-project.ts';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const CONFIG = `import { defineEngine } from 'e2e/engine';

export default {
  targets: [
    {
      name: 'fake',
      platform: 'custom',
      engine: defineEngine({
        name: 'fake',
        version: '1',
        spiVersion: 1,
        observe: async () => snapshot([]),
      }),
    },
  ],
  cache: 'off',
};
`;

const DIRECT = `import { test } from 'e2e';

test('declares its source', async () => {});
`;

/** A project helper every test goes through, as suites with shared setup have. */
const HELPER = `import { test } from 'e2e';

export function dashboardTest(title: string, body: () => Promise<void>) {
  return test(title, async () => {
    await body();
  });
}
`;

const WRAPPED = `import { dashboardTest } from '../support/test.ts';

dashboardTest('declares its source through a helper', async () => {});
`;

const SHARED = `import { test } from 'e2e';

test('declares its source in an imported module', async () => {});
`;

const IMPORTS_SHARED = `import './shared/declarations.ts';
`;

describe('test source location', () => {
  const project = createProject({
    'e2e.config.ts': CONFIG,
    'support/test.ts': HELPER,
    'tests/direct.e2e.ts': DIRECT,
    'tests/wrapped.e2e.ts': WRAPPED,
    'tests/imports-shared.e2e.ts': IMPORTS_SHARED,
    'tests/shared/declarations.ts': SHARED,
  });
  let report: Report;

  afterAll(() => {
    project.cleanup();
  });

  const sourceOf = (title: string) => {
    const result = report.run.results.find((candidate) => candidate.titlePath.at(-1) === title);
    expect(result, title).toBeDefined();
    return result!.source;
  };

  it('runs the project once with source maps as users see them', async () => {
    const outcome = await execFileAsync(process.execPath, [CLI, 'run'], {
      cwd: project.dir,
      env: { ...process.env, CI: '' },
    }).catch((error: { stdout?: string; stderr?: string }) => error);
    report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as Report;
    expect(report.run.status, `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`).toBe('passed');
    expect(report.run.results).toHaveLength(3);
  });

  it('points at the test() call in the test file, not at the runner', () => {
    expect(sourceOf('declares its source')).toEqual({
      file: 'tests/direct.e2e.ts',
      line: 3,
      column: 1,
    });
  });

  it('points at the helper call in the test file, not inside the helper', () => {
    expect(sourceOf('declares its source through a helper')).toEqual({
      file: 'tests/wrapped.e2e.ts',
      line: 3,
      column: 1,
    });
  });

  it('points into an imported module that declares the test itself', () => {
    expect(sourceOf('declares its source in an imported module')).toEqual({
      file: 'tests/shared/declarations.ts',
      line: 3,
      column: 1,
    });
  });

  it('selects the test a file:line positional names by that mapped line, in any positional form', async () => {
    const env = { ...process.env, CI: '' };
    const listed = await execFileAsync(
      process.execPath,
      [CLI, 'list', '--reporter', 'json', 'tests/direct.e2e.ts:3', 'wrapped:3'],
      { cwd: project.dir, env },
    );
    const { pairs } = JSON.parse(listed.stdout) as { pairs: { title: string }[] };
    expect(pairs.map((pair) => pair.title)).toEqual(['declares its source', 'declares its source through a helper']);

    const missed = await execFileAsync(process.execPath, [CLI, 'list', 'tests/direct.e2e.ts:2'], { cwd: project.dir, env }).then(
      (): never => {
        throw new Error('expected the list to fail');
      },
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(missed.code).toBe(2);
    expect(missed.stderr).toContain(
      'NO_TESTS: 3 tests were collected but none is runnable: 1 not declared at a line a positional named: tests/direct.e2e.ts:2 names no test (declared at line 3), 2 file not selected by a positional argument; pass --pass-with-no-tests to allow this',
    );

    // A test the file registers from an imported module is declared there; line 3 of the importer names nothing.
    const imported = await execFileAsync(process.execPath, [CLI, 'list', 'tests/imports-shared.e2e.ts:3'], { cwd: project.dir, env }).then(
      (): never => {
        throw new Error('expected the list to fail');
      },
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(imported.code).toBe(2);
    expect(imported.stderr).toContain('tests/imports-shared.e2e.ts:3 names no test (the file declares no test itself)');
  });
});
