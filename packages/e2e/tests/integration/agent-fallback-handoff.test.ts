/** Pixel-only evidence survives the cache handoff and every default-agent screen update. */

import { describe, expect, it } from 'vitest';
import { defineEngine, EngineError, type EngineSnapshot } from '../../src/engine/index.ts';
import { buildTraceEntry, type RecordedAction } from '../../src/cache/trace.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { runProject } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const SUITE = `import { test } from 'e2e';
test('fallback', async ({ agent }) => { await agent.act('inspect the current result', { timeout: 1500 }); });`;
const VIEWPORT = { width: 2, height: 2, scale: 1 };

/** The engine keeps a viewport reference while exposing no semantic nodes. */
function pixelSnapshot(value = 1): EngineSnapshot {
  return {
    root: { ref: { id: 'root', revision: '' } },
    location: 'fixture:result',
    viewport: VIEWPORT,
    treeUnavailable: true,
    pixels: { data: new Uint8Array([value, 2, 3]), mediaType: 'image/png', ...VIEWPORT },
    maskedRegionCount: 0,
  };
}

describe('semantic fallback handoff', () => {
  it('uses a completed fallback directly with the default read-write cache', async () => {
    const captures: boolean[] = [];
    const engine = defineEngine({
      name: 'fallback-fixture', version: '1', spiVersion: 1, platform: 'fixture',
      observe: async (operation, options) => {
        const permitted = options?.pixelFallback === true;
        captures.push(permitted);
        await new Promise((resolve) => setTimeout(resolve, Math.min(permitted ? 350 : operation.timeoutMs, operation.timeoutMs)));
        if (!permitted || operation.timeoutMs < 350 || operation.signal.aborted) {
          throw new EngineError('OPERATION_TIMEOUT', 'semantic capture timed out', { retryable: false });
        }
        return pixelSnapshot();
      },
    });
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read screenshot' } }]);
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', actionTimeout: 1000, targets: [{ name: 'fixture', engine }], agents: { default: { model } } },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      expect(captures).toEqual([true]);
      expect(loopCalls).toHaveLength(1);
      expect(loopCalls[0]?.imageParts).toBe(1);
      expect(loopCalls[0]?.prompt).toContain('semantic capture unavailable');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('shows unavailable evidence and recovered semantics without reusing old node assurances', async () => {
    let phase: 'initial' | 'pixels' | 'recovered' = 'initial';
    const engine = defineEngine({
      name: 'transition-fixture', version: '1', spiVersion: 1, platform: 'fixture', actions: ['tap'],
      perform: async () => { phase = 'pixels'; },
      observe: async () => {
        if (phase === 'pixels') {
          phase = 'recovered';
          return pixelSnapshot();
        }
        return {
          root: { ref: { id: 'root', revision: '' }, children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }] },
          viewport: VIEWPORT,
        };
      },
    });
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) return [{ toolName: 'tap', input: { target: 'save' } }];
      if (call.turn === 2) return [{ toolName: 'observe', input: {} }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read recovered screen' } }];
    });
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: { tests: 'tests/**/*.e2e.ts', cache: 'off', targets: [{ name: 'fixture', engine }], agents: { default: { model } } },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      expect(loopCalls).toHaveLength(3);
      expect(loopCalls[1]?.lastToolResult).toContain('previous node ids are no longer valid');
      expect(loopCalls[1]?.lastToolResult).toContain('never infer absence');
      expect(loopCalls[1]?.lastToolResult).not.toContain('keeps the id');
      expect(loopCalls[2]?.lastToolResult).toContain('Current screen');
      expect(loopCalls[2]?.lastToolResult).not.toContain('Screen changes');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it.each(['zero-actions', 'failed-capture', 'replayed-action'] as const)('hands off current evidence after replay with %s', async (scenario) => {
    let captures = 0;
    let actions = 0;
    const engine = defineEngine({
      name: 'replay-fixture', version: '1', spiVersion: 1, platform: 'fixture', actions: ['tap', 'swipe'],
      perform: async () => { actions += 1; },
      observe: async () => {
        captures += 1;
        if (captures === 3 && scenario === 'failed-capture') {
          throw new EngineError('OPERATION_TIMEOUT', 'replay observation failed', { retryable: false });
        }
        if (captures > 2) return pixelSnapshot(captures);
        return {
          root: { ref: { id: 'root', revision: '' }, children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }] },
          location: 'https://fixture.test/start', viewport: VIEWPORT,
        };
      },
    });
    const recorded: RecordedAction[] = [{ name: 'tap', target: { role: 'button', name: 'Save' }, summary: 'saved' }];
    if (scenario === 'replayed-action') recorded.unshift({ name: 'scroll', direction: 'down', summary: 'scrolled' });
    const entry = buildTraceEntry({ actions: recorded, startPath: '/start', summary: 'saved', executor: { name: 'fixture' } });
    const executor: StepExecutor = {
      name: 'replay-executor',
      async runStep(context) {
        expect(captures).toBe(3);
        expect(actions).toBe(scenario === 'replayed-action' ? 1 : 0);
        expect(context.replayedPrefix?.replayedActions).toEqual(scenario === 'replayed-action' ? ['scrolled'] : undefined);
        const current = await context.observe({ tree: true });
        const expectedCaptures = scenario === 'zero-actions' ? 3 : 4;
        expect(captures).toBe(expectedCaptures);
        expect(current.treeUnavailable).toBe(true);
        expect(current.tree).toBeUndefined();
        expect(current.pixels?.data[0]).toBe(expectedCaptures);
        await expect(context.actions.tap({ id: 'save' })).rejects.toThrow('previous node ids are no longer valid');
        return { status: 'passed', summary: 'read current evidence after replay' };
      },
    };
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: {
        tests: 'tests/**/*.e2e.ts', targets: [{ name: 'fixture', engine }], agents: { default: executor },
        cache: { mode: 'read-write', store: { writable: true, read: async () => ({ status: 'hit', entry, bytes: 1 }), write: async () => undefined } },
      },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.attempts[0]?.error).toBeUndefined();
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it.each(['none', 'scroll', 'failed-scroll'] as const)('reuses the cache capture once, unless an intervening action is %s', async (action) => {
    let captures = 0;
    let value = 1;
    const engine = defineEngine({
      name: 'reuse-fixture', version: '1', spiVersion: 1, platform: 'fixture', actions: ['swipe'],
      observe: async () => { captures += 1; return pixelSnapshot(value); },
      perform: async () => {
        value = 9;
        if (action === 'failed-scroll') throw new EngineError('OPERATION_TIMEOUT', 'scroll timed out', { retryable: false });
      },
    });
    const executor: StepExecutor = {
      name: 'reuse-executor',
      async runStep(context) {
        expect(captures).toBe(1);
        if (action !== 'none') {
          await context.actions.scroll('down').catch(() => undefined);
        }
        const first = await context.observe({ tree: true });
        expect(first.treeUnavailable).toBe(true);
        expect(first.tree).toBeUndefined();
        expect(first.pixels?.data[0]).toBe(value);
        expect(captures).toBe(action === 'none' ? 1 : 2);
        const second = await context.observe();
        expect(second.revision).not.toBe(first.revision);
        expect(captures).toBe(action === 'none' ? 2 : 3);
        return { status: 'passed', summary: 'observations remained current' };
      },
    };
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', targets: [{ name: 'fixture', engine }], agents: { default: executor } },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.attempts[0]?.error).toBeUndefined();
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });
});
