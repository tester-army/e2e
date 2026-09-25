/** Scrolling to text settles each page once, including on a zero-turn replay. */

import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting } from '../helpers/run-project.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';

const SUITE = `import { test, expect } from 'e2e';
test('reaches and taps the row', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('reach and tap the final row');
  await expect(screen.getByRole('status', { name: 'Result' })).toHaveText('tapped');
});`;

describe('the look after scrolling to text', () => {
  it.each([0, 2])('keeps the stability check without another change wait after %i pages', async (pages) => {
    let observations = 0;
    let afterScroll = 0;
    let executorCalls = 0;
    let observationsAtLastSwipe = 0;
    const beforeTap: number[] = [];
    const fake = createFakeEngine({
      actions: ['tap', 'swipe'],
      observe: () => { observations += 1; },
      perform: (_ref, action) => {
        if (action.kind === 'swipe') observationsAtLastSwipe = observations;
        if (action.kind === 'tap') beforeTap.push(observations - observationsAtLastSwipe);
      },
      scene: () => {
        const result: ScriptedNode = { id: 'result', role: 'status', name: 'Result', text: 'waiting' };
        return [result, {
          id: 'row', role: 'button', name: 'Final row', appearsAfterSwipes: pages,
          rect: { x: 0, y: 20, width: 100, height: 40 },
          on: (action) => { if (action.kind === 'tap') result.text = 'tapped'; },
        }];
      },
    });
    const executor: StepExecutor = {
      name: 'scroll-settle', version: '1',
      async runStep(context) {
        executorCalls += 1;
        await context.observe();
        await context.actions.scrollUntil('Final row', 'down');
        const started = observations;
        const screen = await context.observe();
        afterScroll = observations - started;
        await context.actions.tap({ id: nodeIdFor(screen.text, /button "Final row"/u) });
        return { status: 'passed', summary: 'tapped the final row' };
      },
    };
    const project = createProject({ 'tests/scroll.e2e.ts': SUITE });
    const options = {
      appUrl: FAKE_APP_URL,
      config: { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'device', platform: 'ios' as const, engine: fake.engine }], agents: { default: executor }, cache: 'read-write' as const },
    };
    try {
      const recorded = await runExisting(project, options);
      const replayed = await runExisting(project, options);
      expect(recorded.exitCode, JSON.stringify(recorded.report.run.errors)).toBe(0);
      expect(replayed.exitCode).toBe(0);
      expect(executorCalls).toBe(1);
      const replay = resultByTitle(replayed, 'reaches and taps the row').attempts[0]!.steps.find((step) => step.api === 'agent.act');
      expect(replay?.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 2 });
      console.info(`scroll-to-text ${String(pages)} pages: ${String(replay?.durationMs)} ms replay, ${String(afterScroll)} captures after the live action`);
      expect(afterScroll).toBe(2);
      if (pages > 0) expect(beforeTap).toEqual([4, 4]);
    } finally {
      project.cleanup();
    }
  });

  it('still waits for the final scrollIntoView operation to change the screen', async () => {
    let afterScroll: string | undefined;
    const fake = createFakeEngine({
      actions: ['tap', 'swipe', 'scrollIntoView'],
      scene: (stage) => {
        const result: ScriptedNode = { id: 'result', role: 'status', name: 'Result', text: 'waiting' };
        return [result, {
          id: 'row', role: 'button', name: 'Final row',
          rect: { x: 0, y: 900, width: 100, height: 40 },
          on: (action) => {
            if (action.kind === 'scrollIntoView') stage.after(250, () => { result.text = 'in view'; });
            if (action.kind === 'tap') result.text = 'tapped';
          },
        }];
      },
    });
    const executor: StepExecutor = {
      name: 'scroll-into-view',
      async runStep(context) {
        await context.observe();
        await context.actions.scrollUntil('Final row', 'down');
        const screen = await context.observe();
        afterScroll = screen.text;
        await context.actions.tap({ id: nodeIdFor(screen.text, /button "Final row"/u) });
        return { status: 'passed', summary: 'tapped the final row' };
      },
    };
    const project = createProject({ 'tests/scroll.e2e.ts': SUITE });
    try {
      const outcome = await runExisting(project, {
        appUrl: FAKE_APP_URL,
        config: { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'surface', platform: 'web', engine: fake.engine }], agents: { default: executor } },
      });
      expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
      expect(afterScroll).toContain('in view');
    } finally {
      project.cleanup();
    }
  });
});
