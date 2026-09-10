import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

describe('reported model usage', () => {
  it('keeps run totals representable when separate steps overflow their sum', async () => {
    const project = createProject({ 'tests/usage.e2e.ts': `import { test } from '@e2edev/e2e';
      test('judge twice', async ({ agent }) => {
        await agent.assert('ready');
        await agent.assert('still ready');
      });` });
    const model = createScriptedInstance('test', 'usage', async () => ({
      ...scriptedResult([{ type: 'text', text: JSON.stringify(judgment(true, 'ready')) }], 'stop'),
      usage: { inputTokens: { total: Number.MAX_SAFE_INTEGER }, outputTokens: { total: 0 } },
      providerMetadata: { gateway: { cost: String(Number.MAX_VALUE) } },
    }));
    try {
      const outcome = await runExisting(project, { appUrl: 'http://127.0.0.1:4599', config: {
        targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({
          name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }),
        }) }], agents: { default: { model } }, cache: 'off',
      } });
      expect(outcome.status).toBe('passed');
      assertValidReport(outcome.report);
      assertValidReport(JSON.parse(readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8')));
      expect(outcome.report.run.usage.modelTokens).toBe(Number.MAX_SAFE_INTEGER);
      expect(outcome.report.run.usage).not.toHaveProperty('estimatedCostUsd');
      expect(outcome.results[0]!.attempts[0]!.steps.map((step) => step.model?.estimatedCostUsd))
        .toEqual([Number.MAX_VALUE, Number.MAX_VALUE]);
    } finally {
      project.cleanup();
    }
  });

  it.each([-1, 0.5, NaN, Infinity])('sanitizes malformed judgment counters (%s) before recording events', async (invalid) => {
    const project = createProject({ 'tests/usage.e2e.ts': `import { test } from '@e2edev/e2e';
      test('judge', async ({ agent }) => { await agent.assert('ready'); });` });
    const model = createScriptedInstance('test', 'usage', async () => ({
      ...scriptedResult([{ type: 'text', text: JSON.stringify(judgment(true, 'ready')) }], 'stop'),
      usage: { inputTokens: { total: invalid }, outputTokens: { total: 3 } },
      providerMetadata: { gateway: { cost: '0.25' } },
    }));
    try {
      const outcome = await runExisting(project, { appUrl: 'http://127.0.0.1:4599', config: {
        targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({
          name: 'fake', version: '1', spiVersion: 1, observe: async () => ({ nodes: [] }),
        }) }], agents: { default: { model } }, cache: 'off',
      } });
      expect(outcome.status).toBe('passed');
      assertValidReport(outcome.report);
      assertValidReport(JSON.parse(readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8')));
      const step = outcome.results[0]!.attempts[0]!.steps[0]!;
      expect(step.events.find((event) => event.kind === 'model')?.count).toBe(3);
      expect(step.model).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 3, peakTokensPerCall: 3,
        tokenAccounting: 'adapter-upper-bound', estimatedCostUsd: 0.25 });
    } finally {
      project.cleanup();
    }
  });
});
