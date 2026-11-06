/**
 * The trace cache on a canvas whose nodes have only a random test id: the
 * first run records the step without that id as an end anchor and the click
 * target by its shape, and the second replays both with no executor call.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import type { ActionTrace, TraceTargetDescriptor } from '../../src/cache/trace.ts';

const GRAPH_SUITE = `import { test, expect } from 'e2e';

test('adds a node', async ({ app, agent, screen }) => {
  await app.open('/graph');
  await agent.act('add a node');
  await expect(screen.getByRole('status')).toHaveText('Node added');
});

test('selects the node', async ({ app, agent, screen }) => {
  await app.open('/graph?seeded');
  await agent.act('select the node');
  await expect(screen.getByRole('status')).toHaveText('Node selected');
});
`;

/** Taps "Add node" or the node box, by the instruction, unless a replayed prefix already did. */
function graphExecutor(record: { calls: number }): StepExecutor {
  return {
    name: 'graph-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      const observation = await context.observe();
      if ((context.replayedPrefix?.replayedActions.length ?? 0) === 0) {
        const target = context.step.instruction === 'add a node' ? /button "Add node"/ : /box testid="rf__node-/;
        await context.actions.tap({ id: nodeIdFor(observation.text, target) });
      }
      return { status: 'passed' as const, summary: 'tapped' };
    },
  };
}

/** The target of an entry's first action, when it is a tap. */
function firstTapTarget(payload: ActionTrace): TraceTargetDescriptor | undefined {
  const [first] = payload.actions;
  return first?.name === 'tap' ? first.target : undefined;
}

describe('trace cache: a node only a test id minted per node identifies', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: { calls: number }[] = [];

  const options = () => {
    const record = { calls: 0 };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: graphExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/graph.e2e.ts': GRAPH_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records the effect without the minted id, and replays the next run, the click by the id\'s shape', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const payloads = readEntries(project).map(({ entry }) => entry.payload);
    const added = payloads.find((payload) => firstTapTarget(payload)?.name === 'Add node');
    expect(added?.endAnchors).toEqual([{ role: 'status', name: 'Node added' }]);
    const selected = payloads.find((payload) => firstTapTarget(payload)?.testId?.startsWith('rf__node-') === true);
    expect(firstTapTarget(selected!)).toMatchObject({ role: 'box', position: { index: 0, of: 1 } });

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    for (const title of ['adds a node', 'selects the node']) {
      const step = resultByTitle(second, title).attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
      expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
    }
  }, 240_000);
});
