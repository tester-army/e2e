/** The list reporter through the built runner: what a piped log shows, with no terminal to size against. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { visibleWidth } from '../../src/report/format.ts';
import { runProject, type FixtureProject } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** Forty CJK glyphs: eighty columns, over the step label's budget of seventy-two. */
const WIDE_LABEL = '日'.repeat(40);

/** An executor that passes every step without a model, so the run needs neither a browser nor a key. */
const passing: StepExecutor = { name: 'passing', async runStep() { return { status: 'passed', summary: 'done' }; } };

describe('list reporter output', () => {
  it('clips a wide-glyph agent step label to its 72-column budget on the permanent step line', async () => {
    const written: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let project: FixtureProject | undefined;
    try {
      const run = await runProject(
        { 'tests/wide.e2e.ts': `import { test } from 'e2e';
          test('acts on a wide label', async ({ agent }) => { await agent.act(${JSON.stringify(WIDE_LABEL)}); });` },
        {
          appUrl: 'http://127.0.0.1:4599',
          config: {
            targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) }) }],
            agents: { default: passing },
            cache: 'off',
          },
          runOptions: { quiet: false },
        },
      );
      project = run.project;
      stdoutWrite.mockRestore();
      expect(run.outcome.status).toBe('passed');
      const stepLines = stripVTControlCharacters(written.join('')).split('\n').filter((line) => line.includes('agent.act "'));
      expect(stepLines.length).toBeGreaterThan(0);
      for (const line of stepLines) {
        const label = /"([^"]*)"/.exec(line)?.[1];
        expect(label).toBe(`${'日'.repeat(35)}…`);
        expect(visibleWidth(label!)).toBe(71);
      }
    } finally {
      stdoutWrite.mockRestore();
      project?.cleanup();
    }
  });

  it('tallies a --repeat-each run: the tests that passed every run, and the runs of the one that did not', async () => {
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
          test('fails every other run', async () => {
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
          },
          runOptions: { quiet: false, repeatEach: 3, reporters: ['list', 'markdown'] },
        },
      );
      project = run.project;
      stdoutWrite.mockRestore();
      const output = stripVTControlCharacters(written.join(''));
      expect(output).toMatch(/Repeats {2}1 of 2 tests passed all 3 runs\n/u);
      expect(output).toMatch(/× \|fake\| tests\/repeat\.e2e\.ts > fails every other run {2}2\/3 passed · repeat 1 ASSERTION_FAILED\n/u);
      const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
      expect(summary).toContain('**Repeats:** 1 of 2 tests passed all 3 runs');
      expect(summary).toContain('`tests/repeat.e2e.ts` fails every other run: 2/3 passed · repeat 1 ASSERTION_FAILED');
    } finally {
      stdoutWrite.mockRestore();
      project?.cleanup();
    }
  });
});
