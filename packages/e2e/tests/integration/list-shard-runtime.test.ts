/** Runtime JavaScript shards are classified before config and test-module imports. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { ListOptions } from '../../src/runner.ts';

const builtRunnerModule = '../../dist/runner.js';
const { list } = (await import(builtRunnerModule)) as typeof import('../../src/runner.ts');

/** Both module imports leave receipts; test callbacks have a separate receipt. */
function importProject(): FixtureProject {
  return createProject({
    'e2e.config.ts': `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('config-imported', import.meta.url), 'loaded');
export default { tests: ['tests/proof.e2e.ts'], targets: [{ name: 'api', platform: 'api' }] };
`,
    'tests/proof.e2e.ts': `import { test } from 'e2e';
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('imported', import.meta.url), 'loaded');
const ran = () => writeFileSync(new URL('executed', import.meta.url), 'ran');
test('first case', async () => { ran(); });
test('second case', async () => { ran(); });
`,
  });
}

/** A rejected shard must stop before either user-owned module loads. */
function expectNoImports(project: FixtureProject): void {
  expect(existsSync(path.join(project.dir, 'config-imported'))).toBe(false);
  expect(existsSync(path.join(project.dir, 'tests', 'imported'))).toBe(false);
  expect(existsSync(path.join(project.dir, 'tests', 'executed'))).toBe(false);
}

describe('runtime list shard validation before imports', () => {
  it('classifies a JavaScript null shard as INVALID_CONFIG before imports', async () => {
    const project = importProject();
    try {
      // JavaScript callers can supply this value even though the TypeScript API excludes it.
      const options = { cwd: project.dir, shard: null, passWithNoTests: true } as unknown as ListOptions;
      await expect(list(options)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expectNoImports(project);
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('refuses an invalid numeric shard before imports', async () => {
    const project = importProject();
    try {
      await expect(list({ cwd: project.dir, shard: { index: 1.5, total: 2 } }))
        .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expectNoImports(project);
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it.each([
    ['first shard', { index: 1, total: 2 }, 1],
    ['empty valid shard', { index: 3, total: 3 }, 0],
  ] as const)('imports the producer for %s and preserves its IDs', async (_name, shard, count) => {
    const project = importProject();
    try {
      const result = await list({ cwd: project.dir, shard, passWithNoTests: true });
      expect(readFileSync(path.join(project.dir, 'config-imported'), 'utf8')).toBe('loaded');
      expect(readFileSync(path.join(project.dir, 'tests', 'imported'), 'utf8')).toBe('loaded');
      expect(result.pairs.map((pair) => pair.title)).toEqual(['first case', 'second case']);
      expect(result.pairs.filter((pair) => pair.disposition === 'run')).toHaveLength(count);
      expect(result.pairs.every((pair) => pair.target === 'api')).toBe(true);
      expect(new Set(result.pairs.map((pair) => pair.id)).size).toBe(2);
      expect(result.pairs.every((pair) => /^[0-9a-f]{64}$/.test(pair.id))).toBe(true);
      const unsharded = await list({ cwd: project.dir });
      expect(unsharded.pairs.map((pair) => pair.id)).toEqual(result.pairs.map((pair) => pair.id));
      expect(existsSync(path.join(project.dir, 'tests', 'executed'))).toBe(false);
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('records null as a configuration failure through the built internal runner', async () => {
    const project = importProject();
    try {
      const outcome = await runExisting(project, {
        runOptions: { shard: null as unknown as NonNullable<ListOptions['shard']> },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.status).toBe('error');
      expect(outcome.report.run.errors).toEqual([
        expect.objectContaining({ code: 'INVALID_CONFIG', category: 'configuration', phase: 'config' }),
      ]);
      expectNoImports(project);
    } finally {
      project.cleanup();
    }
  });
});
