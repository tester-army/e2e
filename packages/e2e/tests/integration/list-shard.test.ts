/** The built public list API rejects invalid shards before selecting or starting a run. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '../helpers/run-project.ts';
import type { ListOptions } from '../../src/runner.ts';

const builtRunnerModule = '../../dist/runner.js';
const { list } = (await import(builtRunnerModule)) as typeof import('../../src/runner.ts');

/** A real config and registered test bodies; listing must never execute or write a report. */
function shardProject() {
  return createProject({
    'e2e.config.ts': `export default { tests: ['tests/proof.e2e.ts'], targets: [{ name: 'api', platform: 'api' }] };
`,
    'tests/proof.e2e.ts': `import { test } from 'e2e';
import { writeFileSync } from 'node:fs';
const ran = () => writeFileSync(new URL('executed', import.meta.url), 'ran');
test('first case', async () => { ran(); });
test('second case', async () => { ran(); });
`,
  });
}

const invalidShards = [
  ['index zero', 0, 2],
  ['total zero', 1, 0],
  ['negative index', -1, 2],
  ['negative total', 1, -2],
  ['fractional index', 1.5, 2],
  ['fractional total', 1, 2.5],
  ['NaN index', Number.NaN, 2],
  ['NaN total', 1, Number.NaN],
  ['infinite index', Number.POSITIVE_INFINITY, 2],
  ['infinite total', 1, Number.POSITIVE_INFINITY],
  ['unsafe index', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
  ['unsafe total', 1, Number.MAX_SAFE_INTEGER + 1],
  ['index beyond total', 3, 2],
] as const;

const validShards: readonly [string, ListOptions['shard'], number][] = [
  ['unsharded', undefined, 2],
  ['first shard', { index: 1, total: 2 }, 1],
  ['second shard', { index: 2, total: 2 }, 1],
  ['empty valid shard', { index: 3, total: 3 }, 0],
];

describe('the built public list shard contract', () => {
  it.each(invalidShards)('rejects %s as INVALID_CONFIG', async (_name, index, total) => {
    const project = shardProject();
    try {
      await expect(list({ cwd: project.dir, shard: { index, total }, passWithNoTests: true }))
        .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(existsSync(path.join(project.dir, 'tests', 'executed'))).toBe(false);
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it.each(validShards)('preserves %s without executing tests', async (_name, shard, count) => {
    const project = shardProject();
    try {
      const result = await list({ cwd: project.dir, shard, passWithNoTests: true });
      expect(result.pairs.filter((pair) => pair.disposition === 'run')).toHaveLength(count);
      expect(result.pairs.map((pair) => pair.title)).toEqual(['first case', 'second case']);
      expect(result.pairs.every((pair) => pair.target === 'api')).toBe(true);
      expect(existsSync(path.join(project.dir, 'tests', 'executed'))).toBe(false);
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});
