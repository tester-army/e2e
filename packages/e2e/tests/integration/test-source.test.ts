/**
 * A test's reported source is the `test()` call in the test file. The runner
 * reads it off a stack whose frames for its own code, once source-mapped,
 * point at `src/` while the running module lives in `dist/`; those frames must
 * never win. The built CLI is spawned because a vitest fork reports raw
 * transformed positions, while a plain Node process maps them as users see.
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

const CONFIG = `import { defineEngine } from '@e2edev/e2e/engine';

export default {
  targets: [
    {
      name: 'fake',
      platform: 'custom',
      engine: defineEngine({
        name: 'fake',
        version: '1',
        spiVersion: 1,
        observe: async () => ({ nodes: [] }),
      }),
    },
  ],
  cache: 'off',
};
`;

const SUITE = `import { test } from '@e2edev/e2e';

test('declares its source', async () => {});
`;

describe('test source location', () => {
  const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/source.e2e.ts': SUITE });

  afterAll(() => {
    project.cleanup();
  });

  it('points at the test() call in the test file, not at the runner', async () => {
    const outcome = await execFileAsync(process.execPath, [CLI, 'run'], {
      cwd: project.dir,
      env: { ...process.env, CI: '' },
    }).catch((error: { stdout?: string; stderr?: string }) => error);
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as Report;
    expect(report.run.status, `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`).toBe('passed');
    expect(report.run.results[0]?.source).toEqual({ file: 'tests/source.e2e.ts', line: 3, column: 1 });
  });
});
