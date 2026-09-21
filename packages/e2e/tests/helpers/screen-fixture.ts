/**
 * A `screen` fixture over a fake engine that answers every query with the
 * same node list, so locator reads and `expect(locator)` matchers can be
 * exercised without a browser. `index` expressions pick one of the nodes,
 * which is what `all()`, `first()`, and `nth()` need; every other expression
 * kind gets the whole list.
 */

import type { LocatorExpression, SemanticNode } from '../../src/engine/surface.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { Screen } from '../../src/types.ts';
import { snapshot } from './snapshot.ts';

/** Action and assertion timeout of the fixture, short enough for failing-path tests. */
export const SCREEN_FIXTURE_TIMEOUT_MS = 300;

export function createScreenFixture(nodes: readonly SemanticNode[]): Screen {
  const engine: EngineHandle = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => snapshot(nodes),
    locate: async (expression) => pick(expression, nodes),
  });
  const config = resolveConfig(
    {
      targets: [{ name: 'fake', platform: 'custom', engine }],
      cache: 'off',
      actionTimeout: SCREEN_FIXTURE_TIMEOUT_MS,
      assertionTimeout: SCREEN_FIXTURE_TIMEOUT_MS,
    },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    cleanup: { add: () => undefined },
    models: new WorkerModels(() => {}),
  });
  return fixtures.screen;
}

function pick(expression: LocatorExpression, nodes: readonly SemanticNode[]): readonly SemanticNode[] {
  if (expression.kind !== 'index') return nodes;
  const index =
    expression.index === 'first' ? 0 : expression.index === 'last' ? nodes.length - 1 : expression.index;
  const node = nodes[index];
  return node === undefined ? [] : [node];
}
