/**
 * Test declaration locations end to end: a run through the real CLI and tsx
 * loader records the `test()` call site, so `report.json` and `junit.xml`
 * point at the user's file and the list reporter's code frame lands on the
 * failing line, never on a runner frame. The fixture lives outside the
 * package, the layout every installed project has.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import type { Report1Document } from '../../src/report/build.ts';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

// The test() call sits on line 5, the throwing line on 6.
const SUITE = [
  `import { test } from '@e2edev/e2e';`,
  '',
  '',
  '',
  `test('reports its declaration', async () => {`,
  `  throw new Error('marker failure');`,
  `});`,
  '',
].join('\n');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-source-'));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    path.join(dir, 'e2e.config.ts'),
    "export default { targets: [{ name: 'local', platform: 'test' }] };\n",
  );
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'tests', 'source.e2e.ts'), SUITE);
  // Stands in for an install: the package is resolvable under its real name.
  mkdirSync(path.join(dir, 'node_modules', '@e2edev'), { recursive: true });
  symlinkSync(PACKAGE_ROOT, path.join(dir, 'node_modules', '@e2edev', 'e2e'), 'junction');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('test source locations', () => {
  it('reports the declaration line in report.json and junit.xml, and the failing line in the list reporter', async () => {
    const run = await execFileAsync(
      process.execPath,
      [CLI, 'run', '--reporter', 'list,junit'],
      { cwd: dir },
    ).then(
      (result) => ({ code: 0, stdout: result.stdout }),
      (error: { code?: number; stdout?: string }) => ({
        code: error.code ?? -1,
        stdout: error.stdout ?? '',
      }),
    );
    expect(run.code).toBe(1);

    const report = JSON.parse(
      readFileSync(path.join(dir, '.e2e', 'report.json'), 'utf8'),
    ) as Report1Document;
    assertValidReport(report);
    expect(report.run.results[0]?.source).toEqual({
      file: 'tests/source.e2e.ts',
      line: 5,
      column: 1,
    });

    const xml = readFileSync(path.join(dir, '.e2e', 'junit.xml'), 'utf8');
    expect(xml).toContain('file="tests/source.e2e.ts" line="5"');

    // The failing test's code frame names the throwing line in the user file.
    expect(run.stdout).toContain('tests/source.e2e.ts:6:9');
    expect(run.stdout).toContain(`throw new Error('marker failure')`);
  }, 120_000);
});
