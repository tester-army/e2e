import { describe, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/** Creates a locator fixture backed by one stable semantic node. */
function createAttributeFixture(node: SemanticNode) {
  const engine: EngineHandle = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => ({ nodes: [node] }),
    locate: async () => [node],
  });
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off' },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const fixtures = createFixtures({
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
  });
  return fixtures.screen;
}

describe('attribute and focus expectations', () => {
  it('matches attribute presence and values without normalizing whitespace', async () => {
    const screen = createAttributeFixture({
      ref: { id: 'node-1', revision: '' },
      role: 'textbox',
      attributes: { readonly: '', class: 'card  active' },
      states: { focused: true },
    });
    const locator = screen.getByRole('textbox');

    await expectFixture(locator).toHaveAttribute('readonly');
    await expectFixture(locator).toHaveAttribute('readonly', '');
    await expectFixture(locator).toHaveAttribute('class', /active/);
    await expectFixture(locator).not.toHaveAttribute('hidden');
    await expectFixture(locator).toBeFocused();
  });
});
