/** The list reporter through the built runner: what a piped log shows, with no terminal to size against. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { runProject, type FixtureProject } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

describe('list reporter output', () => {
  it('tallies a --repeat-each run: the tests that passed every run, and the flaky runs of the one that did not with the code each retry recovered from', async () => {
    const written: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let project: FixtureProject | undefined;
    try {
      const run = await runProject(
        { 'tests/repeat.e2e.ts': `import { readFileSync, writeFileSync } from 'node:fs';
          import { test, expect } from 'e2e';
          test('always passes', async () => {});
          test('fails every other <b>attempt</b>', async () => {
            const file = new URL('../count.txt', import.meta.url);
            let count = 0;
            try { count = Number(readFileSync(file, 'utf8')); } catch {}
            writeFileSync(file, String(count + 1));
            expect(count % 2).toBe(0);
          });` },
        {
          appUrl: 'http://127.0.0.1:4599',
          config: {
            targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) }) }],
            cache: 'off',
            workers: 1,
            retries: 1,
          },
          runOptions: { quiet: false, repeatEach: 3, reporters: ['list', 'markdown'] },
        },
      );
      project = run.project;
      stdoutWrite.mockRestore();
      const output = stripVTControlCharacters(written.join(''));
      expect(output).toMatch(/Repeats {2}1 of 2 tests passed all 3 runs\n/u);
      // The target badge is `|fake|` without color and ` fake ` on a background with it.
      // Repeat 0 passes at once; 1 and 2 fail their first attempt and pass the retry.
      const line = '1/3 passed · repeat 1 flaky (ASSERTION_FAILED) · repeat 2 flaky (ASSERTION_FAILED)';
      expect(output).toMatch(new RegExp(`× [| ]fake[| ] tests/repeat\\.e2e\\.ts > fails every other <b>attempt</b> {2}${line.replaceAll('(', '\\(').replaceAll(')', '\\)')}\n`, 'u'));
      const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
      expect(summary).toContain('**Repeats:** 1 of 2 tests passed all 3 runs');
      expect(summary).toContain(`\`tests/repeat.e2e.ts\` fails every other &lt;b&gt;attempt&lt;/b&gt;: ${line}`);
    } finally {
      stdoutWrite.mockRestore();
      project?.cleanup();
    }
  });

  it('shows a cleanup failure under a passed test and in the summary, not a green summary with exit 3', async () => {
    const written: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let project: FixtureProject | undefined;
    try {
      const fake = createFakeEngine({
        onEndAttempt() {
          throw new Error('close exploded');
        },
      });
      const run = await runProject(
        {
          'tests/close-fail.e2e.ts': `import { test } from 'e2e';\n\ntest('taps a node', async ({ app, screen }) => {\n  await app.open('/');\n  await screen.getByRole('button', { name: 'Submit' }).tap();\n});\n`,
        },
        {
          appUrl: 'http://127.0.0.1:4599',
          config: engineConfig(fake.engine),
          runOptions: { quiet: false, reporters: ['list'] },
        },
      );
      project = run.project;
      stdoutWrite.mockRestore();
      const output = stripVTControlCharacters(written.join(''));
      expect(run.outcome.exitCode).toBe(3);
      expect(output).toMatch(/✓ .+ tests\/close-fail\.e2e\.ts > taps a node/);
      expect(output).toMatch(/cleanup failed: ENGINE_FAILURE: attempt end failed: close exploded/);
      expect(output).toMatch(/Cleanup +1 cleanup failure: ENGINE_FAILURE: attempt end failed: close exploded/);
    } finally {
      stdoutWrite.mockRestore();
      project?.cleanup();
    }
  });
});
