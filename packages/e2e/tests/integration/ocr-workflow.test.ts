/** The built OCR entrypoint through the real runner, with a scripted engine and provider, no model or device. */
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { defineEngine } from '../helpers/engine-runtime.ts';
import { runProject, runExisting, resultByTitle } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const builtOcr = '../../dist/ocr/index.js';
const { ocrExecutor } = await import(builtOcr) as typeof import('../../src/ocr/index.ts');

/** One unlabelled drawn screen. The PNG changes only when a successful tap changes the state. */
function image(done: boolean) {
  const png = new PNG({ width: 100, height: 200 });
  png.data.fill(done ? 128 : 255);
  return { data: PNG.sync.write(png), width: 100, height: 200, scale: 1, mediaType: 'image/png' as const };
}

const suite = `import { test } from 'e2e';
test('OCR flow', async ({ agent }) => {
  await agent.act('Continue');
  await agent.assert('Complete');
});`;

describe('OCR through the built runner', () => {
  it('captures, recognizes, dispatches, asserts and never replays coordinates', async () => {
    let done = false;
    let reads = 0;
    const taps: unknown[] = [];
    const engine = defineEngine({
      name: 'ocr-fixture', version: '1', spiVersion: 1, platform: 'fixture', pointerActions: ['tap'],
      startAttempt: async () => { done = false; },
      observe: async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 100, height: 200 },
        pixels: image(done), maskedRegionCount: 0 }),
      performAt: async (point, action) => { taps.push({ point, action }); done = true; },
    });
    const executor = ocrExecutor({
      provider: { name: 'fixture', recognize: async () => { reads += 1; return [{ text: done ? 'Complete' : 'Continue',
        confidence: 0.99, rect: { x: 10, y: 20, width: 40, height: 10 } }]; } },
      runStep: async (context, ocr) => {
        if (context.step.kind === 'act') await ocr.tapText({ text: context.step.instruction });
        else await ocr.assertText({ text: context.step.instruction });
        return { status: 'passed', summary: 'OCR evidence verified' };
      },
    });
    const config = { tests: 'tests/**/*.e2e.ts', cache: 'read-write' as const,
      targets: [{ name: 'fixture', engine }], agents: { default: { executor } } };
    const { project, outcome } = await runProject({ 'tests/ocr.e2e.ts': suite }, { config });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
      expect(taps).toEqual([{ point: { x: 30, y: 25 }, action: { kind: 'tap' } }]);
      const firstReads = reads;
      const second = await runExisting(project, { config });
      expect(second.exitCode).toBe(0);
      expect(reads).toBeGreaterThan(firstReads);
      expect(taps).toHaveLength(2);
      for (const result of [outcome, second]) {
        const steps = resultByTitle(result, 'OCR flow').attempts[0]!.steps;
        expect(steps.filter((step) => step.api.startsWith('agent.')).every((step) => step.status === 'passed')).toBe(true);
        expect(steps.some((step) => step.events.some((event) => event.kind === 'model'))).toBe(false);
        assertValidReport(result.report);
      }
    } finally { project.cleanup(); }
  });

  it('keeps the harness action budget in force', async () => {
    let taps = 0;
    const engine = defineEngine({
      name: 'ocr-budget-fixture', version: '1', spiVersion: 1, platform: 'fixture', pointerActions: ['tap'],
      observe: async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 100, height: 200 },
        pixels: image(false), maskedRegionCount: 0 }),
      performAt: async () => { taps += 1; },
    });
    const executor = ocrExecutor({
      maxAgeMs: 10_000,
      provider: { name: 'fixture', recognize: async () => [{ text: 'Continue', confidence: 1, rect: { x: 10, y: 20, width: 40, height: 10 } }] },
      runStep: async (_context, ocr) => {
        await ocr.tapText({ text: 'Continue' });
        await ocr.tapText({ text: 'Continue' });
        return { status: 'passed', summary: 'unreachable' };
      },
    });
    const { project, outcome } = await runProject({ 'tests/ocr.e2e.ts': `import { test } from 'e2e';
      test('budget', async ({ agent }) => { await agent.act('Continue'); });` }, {
      config: { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'fixture', engine }],
        agents: { default: { executor, maxSteps: 1 } } },
    });
    try {
      expect(outcome.exitCode).not.toBe(0);
      expect(taps).toBe(1);
      expect(resultByTitle(outcome, 'budget').attempts[0]!.error?.code).toBe('STEP_BUDGET_EXHAUSTED');
      assertValidReport(outcome.report);
    } finally { project.cleanup(); }
  });
});
