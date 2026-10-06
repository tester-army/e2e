/** Target names are artifact path segments: a name that is only dots is refused before anything runs. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { runProject } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const SUITE = { 'tests/noop.e2e.ts': `import { test } from 'e2e';
  test('does nothing', async () => {});` };
const APP_URL = 'http://127.0.0.1:4599';

function fakeEngine() {
  return defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
}

describe('all-dot names', () => {
  it('refuses a target named `..` as INVALID_CONFIG, so nothing is written beside report.json', async () => {
    const { outcome, project } = await runProject(SUITE, {
      appUrl: APP_URL,
      config: { targets: [{ name: '..', platform: 'custom', engine: fakeEngine() }] },
    });
    try {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors.map((error) => [error.code, error.message])).toEqual([
        ['INVALID_CONFIG', 'invalid target name ".."; target names are limited to ASCII letters, numbers, "_", "-", and ".", and cannot be only dots'],
      ]);
      expect(outcome.results).toHaveLength(0);
      expect(existsSync(path.join(project.dir, '.e2e', 'results'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});
