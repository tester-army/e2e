/** Pixel-only evidence survives the cache handoff and every default-agent screen update, and no model sees it once a secret fill taints the attempt. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEngine, EngineError, type EngineObserveOptions, type EngineSnapshot } from '../../src/engine/index.ts';
import { buildTraceEntry, type RecordedAction } from '../../src/cache/trace.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const SUITE = `import { test } from 'e2e';
test('fallback', async ({ agent }) => { await agent.act('inspect the current result', { timeout: 1500 }); });`;
const VIEWPORT = { width: 2, height: 2 };

/** The engine keeps a viewport reference while exposing no semantic nodes. */
function pixelSnapshot(value = 1): EngineSnapshot {
  return {
    root: { ref: { id: 'root', revision: '' } },
    location: 'fixture:result',
    viewport: VIEWPORT,
    treeUnavailable: true,
    pixels: { data: new Uint8Array([value, 2, 3]), mediaType: 'image/png', ...VIEWPORT, scale: 1 },
    maskedRegionCount: 0,
  };
}

describe('semantic fallback handoff', () => {
  it.each([true, undefined])('requests pixels=%s after a semantic cache probe', async (pixels) => {
    const captures: boolean[] = [];
    const engine = defineEngine({
      name: 'requested-pixels-fixture', version: '1', spiVersion: 1, platform: 'fixture',
      observe: async (_operation, options) => {
        captures.push(options?.pixels === true);
        return {
          root: { ref: { id: 'root', revision: '' }, children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }] },
          viewport: VIEWPORT,
          ...(options?.pixels === true ? { pixels: pixelSnapshot().pixels! } : {}),
        };
      },
    });
    const executor: StepExecutor = {
      name: 'requested-pixels-executor',
      async runStep(context) {
        expect(captures).toEqual([false, false]);
        const observation = await context.observe(pixels === undefined ? {} : { pixels });
        expect(observation.text).toContain('Save');
        expect(observation.treeUnavailable).toBeUndefined();
        expect(captures).toEqual(pixels === true ? [false, false, true, true] : [false, false]);
        expect(observation.pixels).toEqual(pixels === true ? { ...pixelSnapshot().pixels, maskedRegionCount: 0 } : undefined);
        return { status: 'passed', summary: 'read the requested evidence' };
      },
    };
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', targets: [{ name: 'fixture', engine }], agents: { default: { executor } } },
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

  it('types at a point from the opening fallback screenshot', async () => {
    let captures = 0;
    const dispatched: unknown[] = [];
    const engine = defineEngine({
      name: 'fallback-keyboard-fixture', version: '1', spiVersion: 1, platform: 'fixture',
      actions: ['fill', 'press'],
      perform: async () => { throw new Error('fallback must use pointer and keyboard input'); },
      observe: async () => { captures += 1; return pixelSnapshot(captures); },
      performAt: async (point, action) => { dispatched.push([action.kind, point]); },
      pointerActions: ['tap'],
      keyboard: {
        type: async (value, options) => { dispatched.push(['type', value, options]); },
        press: async () => undefined,
      },
    });
    const model = installFakeLoopModel((call) => call.turn === 1
      ? [{ toolName: 'type_at', input: { x: 1, y: 1, value: 'hello', replace: true } }]
      : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'typed into the drawn field' } }]);
    const { project, outcome } = await runProject({ 'tests/fallback.e2e.ts': SUITE }, {
      appUrl: 'https://fixture.test',
      config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', targets: [{ name: 'fixture', engine }], agents: { default: { model } } },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.attempts[0]?.error).toBeUndefined();
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      expect(dispatched).toEqual([['tap', { x: 1, y: 1 }], ['type', 'hello', { replace: true }]]);
      expect(captures).toBe(2);
      expect(loopCalls).toHaveLength(2);
      expect(loopCalls[0]?.imageParts).toBe(1);
      expect(loopCalls[0]?.toolNames).toContain('type_at');
      expect(loopCalls[0]?.prompt).toContain('semantic capture unavailable');
      expect(loopCalls[1]?.lastToolResult).toContain('semantic capture unavailable');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

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
      expect(loopCalls[0]?.prompt).toContain('Screenshot attached: 2 by 2');
      expect(loopCalls[0]?.prompt).toContain('semantic capture unavailable');
      expect(loopCalls[0]?.prompt).toContain('never infer absence');
      expect(outcome.report.run.results[0]!.attempts[0]!.steps.find((step) => step.api === 'agent.act')?.visionInput).toBe(true);
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

  const tapSave: RecordedAction = { name: 'tap', target: { role: 'button', name: 'Save' }, summary: 'saved' };
  const scrollDown: RecordedAction = { name: 'scroll', direction: 'down', summary: 'scrolled' };

  /**
   * Three ways a replay ends on evidence it took itself. Captures 1 and 2 are
   * the settled start, which the first action's look reads rather than
   * looking again, so every scenario's failure lands on capture 3, the
   * replay's first capture of its own: the relocation's retry look when the
   * recorded control is not on the start screen (`zero-actions`), or the
   * look before the tap that follows a replayed scroll.
   */
  const handOffs = {
    'zero-actions': {
      recorded: [{ ...tapSave, target: { role: 'button', name: 'Submit' }, summary: 'submitted' }],
      failure: 'pixels',
      prefix: undefined,
      cache: { mode: 'missed', reason: 'target-not-found', replayedActions: 0, totalActions: 1 },
    },
    'failed-capture': {
      recorded: [scrollDown, tapSave],
      failure: 'throw',
      prefix: ['scrolled'],
      cache: { mode: 'agent-concluded', reason: 'action-failed', replayedActions: 1, totalActions: 2 },
    },
    'replayed-action': {
      recorded: [scrollDown, tapSave],
      failure: 'pixels',
      prefix: ['scrolled'],
      cache: { mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1, totalActions: 2 },
    },
  } as const;

  it.each(Object.keys(handOffs) as (keyof typeof handOffs)[])('hands off current evidence after replay with %s', async (scenario) => {
    const expected = handOffs[scenario];
    let captures = 0;
    let actions = 0;
    const engine = defineEngine({
      name: 'replay-fixture', version: '1', spiVersion: 1, platform: 'fixture', actions: ['tap', 'swipe'],
      perform: async () => { actions += 1; },
      observe: async () => {
        captures += 1;
        if (captures <= 2) {
          return {
            root: { ref: { id: 'root', revision: '' }, children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }] },
            location: 'https://fixture.test/start', viewport: VIEWPORT,
          };
        }
        if (captures === 3 && expected.failure === 'throw') {
          throw new EngineError('OPERATION_TIMEOUT', 'replay observation failed', { retryable: false });
        }
        return pixelSnapshot(captures);
      },
    });
    // The target declares no app, so the location is compared whole, origin included.
    const entry = buildTraceEntry({ actions: [...expected.recorded], startPath: 'https://fixture.test/start', summary: 'saved', executor: { name: 'fixture' } });
    const executor: StepExecutor = {
      name: 'replay-executor',
      async runStep(context) {
        expect(captures).toBe(3);
        expect(actions).toBe(expected.prefix === undefined ? 0 : 1);
        expect(context.replayedPrefix?.replayedActions).toEqual(expected.prefix);
        const current = await context.observe({ tree: true });
        // A look that lost semantics before any action still serves the
        // executor's first look once; after an action, or after a look that
        // threw, the executor takes a look of its own.
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
        tests: 'tests/**/*.e2e.ts', targets: [{ name: 'fixture', engine }], agents: { default: { executor } },
        cache: { mode: 'read-write', store: { writable: true, read: async () => ({ status: 'hit', entry, bytes: 1 }), write: async () => undefined } },
      },
    });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      const attempt = outcome.report.run.results[0]?.attempts[0];
      expect(attempt?.error).toBeUndefined();
      expect(outcome.report.run.results[0]?.status).toBe('passed');
      // The report says how far the replay got and why it stopped.
      expect(attempt?.steps.find((step) => step.api === 'agent.act')?.cache).toEqual(expected.cache);
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
      config: { tests: 'tests/**/*.e2e.ts', cache: 'read-write', targets: [{ name: 'fixture', engine }], agents: { default: { executor } } },
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

const SEMANTIC_SUITE = `import { test, credentials } from 'e2e';
test('vision judgment receives fallback', async ({ agent }) => {
  await agent.assert('the screenshot shows the result', { vision: true });
});
test('tree-only judgment cannot infer absence', async ({ agent }) => {
  await agent.assert('nothing is visible', { vision: false });
});
test('act cannot recover pixels after a secret fill', async ({ agent, screen }) => {
  await screen.getByRole('textbox').fill(credentials.user('member').password);
  await agent.act('read the tainted screenshot');
});
test('judgment cannot recover pixels after a secret fill', async ({ agent, screen }) => {
  await screen.getByRole('textbox').fill(credentials.user('member').password);
  await agent.assert('read the tainted result', { vision: true });
});
test('tree-only judgment after a secret fill keeps the engine timeout', async ({ agent, screen }) => {
  await screen.getByRole('textbox').fill(credentials.user('member').password);
  await agent.assert('the tainted result is listed', { vision: false });
});`;

describe('agent semantic fallback through the engine contract', () => {
  let project: FixtureProject;
  let outcome: RunOutcome;
  const captures: { filled: boolean; options: EngineObserveOptions | undefined }[] = [];

  beforeAll(async () => {
    let filled = false;
    const engine = defineEngine({
      name: 'masked-fixture', version: '1', spiVersion: 1, platform: 'fixture',
      actions: ['fill'],
      startAttempt: async () => { filled = false; },
      locate: async () => [{ ref: { id: 'password', revision: '' }, role: 'textbox', inputPurpose: 'password', states: { secure: true } }],
      perform: async () => { filled = true; },
      observe: async (_operation, options) => {
        captures.push({ filled, options });
        if (options?.pixelFallback !== true) {
          throw new EngineError('OPERATION_TIMEOUT', 'semantic capture timed out', { retryable: false });
        }
        return {
          root: { ref: { id: 'root', revision: '' } },
          location: 'fixture:result',
          viewport: { width: 2, height: 2 },
          treeUnavailable: true,
          pixels: { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2, scale: 1 },
          maskedRegionCount: 0,
        };
      },
    });
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read pixels' } }]);
    const judge = installFakeModel(() => judgment(true, 'visible in the screenshot'));
    const result = await runProject({ 'tests/fallback.e2e.ts': SEMANTIC_SUITE }, {
      appUrl: 'https://fixture.test',
      config: {
        tests: 'tests/**/*.e2e.ts',
        targets: [{ name: 'fixture', engine }],
        agents: { default: { model, judge } },
        credentials: { member: { username: 'member', password: 'fixture-secret-value' } },
      },
    });
    project = result.project;
    outcome = result.outcome;
    expect(outcome.report.run.errors).toEqual([]);
  });

  afterAll(() => project?.cleanup());

  it('judges the current screenshot with vision enabled', () => {
    expect(resultByTitle(outcome, 'vision judgment receives fallback').status).toBe('passed');
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0]!.images).toEqual([{ mediaType: 'image/png', bytes: 3 }]);
    expect(fakeCalls[0]!.observation).toContain('semantic capture unavailable');
  });

  it('stops tree-only and tainted judgments before a model call', () => {
    for (const title of ['tree-only judgment cannot infer absence', 'tree-only judgment after a secret fill keeps the engine timeout']) {
      const result = resultByTitle(outcome, title);
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.message).toContain('timed out');
    }
    for (const title of ['act cannot recover pixels after a secret fill', 'judgment cannot recover pixels after a secret fill']) {
      const error = resultByTitle(outcome, title).attempts[0]!.error;
      expect(error?.code).toBe('POLICY_DENIED');
      expect(error?.message).toContain('a secret was filled in this attempt');
    }
    const tainted = captures.filter((capture) => capture.filled);
    expect(tainted.length).toBeGreaterThanOrEqual(3);
    expect(tainted.every((capture) => capture.options?.pixelFallback !== true && capture.options?.pixels !== true)).toBe(true);
    expect(loopCalls).toEqual([]);
    assertValidReport(outcome.report);
  });
});
