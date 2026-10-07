/**
 * An agent step records where its last action landed, as a locator step
 * does: the box of the node it acted on, in CSS pixels, the point of a
 * positioned tap, and nothing after an action with no node. Real runner and
 * web engine, scripted executor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutorNode, StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
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

  /** Runs one `agent.act` driven by `runStep` and returns that step from the report. */
  async function actStep(runStep: StepExecutor['runStep']) {
    const executor: StepExecutor = { name: 'scripted', runStep };
    const suite = `import { test } from 'e2e';

test('one act', async ({ app, agent }) => {
  await app.open();
  await agent.act('act on the counter');
});
`;
    const { outcome, project } = await runProject(
      { 'tests/act.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } } },
    );
    try {
      const result = resultByTitle(outcome, 'one act');
      expect(result.status).toBe('passed');
      return result.attempts.at(-1)!.steps.find((step) => step.api === 'agent.act')!;
    } finally {
      project.cleanup();
    }
  }

  /** The node named `name` in an observed tree. */
  function findNode(node: ExecutorNode | undefined, name: string): ExecutorNode | undefined {
    if (node === undefined) return undefined;
    if (node.name === name) return node;
    for (const child of node.children ?? []) {
      const found = findNode(child, name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  it('records the box of the node the agent tapped, as the observation measured it', async () => {
    let observed: ExecutorNode['rect'];
    const act = await actStep(async (context: StepExecutorContext) => {
      const observation = await context.observe({ tree: true });
      observed = findNode(observation.tree, 'Increment')?.rect;
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
      return { status: 'passed' as const, summary: 'tapped once' };
    });
    expect(observed).toBeDefined();
    expect(act.target).toEqual({ box: { x: observed!.x, y: observed!.y, width: observed!.width, height: observed!.height } });
  }, 120_000);

  it('records the point of a positioned tap and the box it landed in; on a control, that control as a node tap', async () => {
    let heading: ExecutorNode['rect'];
    let button: ExecutorNode['rect'];
    const centre = (rect: NonNullable<ExecutorNode['rect']>) => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    const onText = await actStep(async (context: StepExecutorContext) => {
      const observation = await context.observe({ tree: true });
      heading = findNode(observation.tree, 'Home')?.rect;
      await context.actions.tapAt(centre(heading!));
      return { status: 'passed' as const, summary: 'tapped the heading' };
    });
    expect(onText.target).toEqual({ point: centre(heading!), box: { x: heading!.x, y: heading!.y, width: heading!.width, height: heading!.height } });

    const onControl = await actStep(async (context: StepExecutorContext) => {
      const observation = await context.observe({ tree: true });
      button = findNode(observation.tree, 'Increment')?.rect;
      await context.actions.tapAt(centre(button!));
      return { status: 'passed' as const, summary: 'tapped the button by its point' };
    });
    expect(onControl.target).toEqual({ box: { x: button!.x, y: button!.y, width: button!.width, height: button!.height } });
  }, 120_000);

  it('records no target when its last action had no node or point', async () => {
    const act = await actStep(async (context: StepExecutorContext) => {
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Increment"/) });
      await context.actions.pressKey('Tab');
      return { status: 'passed' as const, summary: 'tapped, then pressed a key' };
    });
    expect(act.target).toBeUndefined();
  }, 120_000);
});
