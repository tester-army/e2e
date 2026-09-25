/** The action's change window includes device capture time and delays before observation. */

import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { runProject } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';
test('observes after an unchanged scroll', async ({ agent }) => {
  await agent.act('scroll once and inspect the result');
});`;

describe('the action change deadline', () => {
  it.each(['capture', 'executor'] as const)('counts time spent in the %s before checking stability', async (delayIn) => {
    let scrolled = false;
    let captures = 0;
    const fake = createFakeEngine({
      actions: ['swipe'],
      tree: {
        ref: { id: 'root', revision: '' }, role: 'document',
        children: [{ ref: { id: 'content', revision: '' }, role: 'text', text: 'End of list' }],
      },
      perform: () => { scrolled = true; },
      observe: async () => {
        if (!scrolled) return;
        captures += 1;
        if (delayIn === 'capture') await setTimeout(700);
      },
    });
    const executor: StepExecutor = {
      name: 'delayed-observer',
      async runStep(context) {
        await context.observe();
        await context.actions.scroll('down');
        if (delayIn === 'executor') await setTimeout(700);
        const screen = await context.observe();
        expect(screen.text).toContain('End of list');
        return { status: 'passed', summary: 'the list has not changed' };
      },
    };
    const { outcome, project } = await runProject({ 'tests/observe.e2e.ts': SUITE }, {
      appUrl: FAKE_APP_URL,
      config: {
        targets: [{ name: 'device', platform: 'ios', engine: fake.engine }],
        agents: { default: executor }, cache: 'off',
      },
    });
    try {
      expect(outcome.exitCode).toBe(0);
      expect(captures).toBe(2);
    } finally {
      project.cleanup();
    }
  });
});
