/** The list reporter through the built runner: what a piped log shows, with no terminal to size against. */

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
});
