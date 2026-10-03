/**
 * An agent step records where its last action landed, as a locator step
 * does: the box of the node it acted on in CSS pixels, so a viewer can draw
 * the cursor on the step's frame. Real runner and web engine, scripted executor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('agent step target', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records the box of the node the agent tapped, and the viewport it is measured against', async () => {
    const executor: StepExecutor = {
      name: 'tap-executor',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
        return { status: 'passed' as const, summary: 'tapped once' };
      },
    };
    const suite = `import { test } from 'e2e';

test('one tap', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap increment');
});
`;
    const { outcome, project } = await runProject(
      { 'tests/tap.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, evidence: false } },
    );
    try {
      const result = resultByTitle(outcome, 'one tap');
      expect(result.status).toBe('passed');
      const act = result.attempts.at(-1)!.steps.find((step) => step.api === 'agent.act')!;
      const box = act.target?.box;
      expect(box).toBeDefined();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
