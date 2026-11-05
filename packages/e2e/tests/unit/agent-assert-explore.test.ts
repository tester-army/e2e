/** The built-in agent's exploring assertion loop: its rules, its evidence policy, and its verdict vocabulary. */

import { expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(engine: EngineHandle, overrides: Partial<E2EConfig> = {}) {
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
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
    attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

const ready = () =>
  defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([{ ref: { id: 'n1', revision: '' }, role: 'text', name: 'Ready' }]) });

it("appends the agents entry's system to the exploring assertion's rules", async () => {
  const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Ready is shown' } }]);
  const { fixtures } = runtime(ready(), { agents: { default: { model, system: 'Plans are called tiers.' } } });
  await fixtures.agent.assert('the screen says Ready', { explore: true });
  expect(loopCalls[0]!.system).toContain('You are judging exactly one assertion');
  expect(loopCalls[0]!.system).toContain('Plans are called tiers.');
});

it('drops an inconclusive code an act verdict sends, so the act fails with its own code', async () => {
  const model = installFakeLoopModel(() => [
    { toolName: 'complete_step', input: { status: 'failed', summary: 'no Save button', errorCode: 'ASSERTION_INCONCLUSIVE' } },
  ]);
  const { fixtures } = runtime(ready(), { agents: { default: { model } } });
  await expect(fixtures.agent.act('save the form')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  expect(loopCalls).toHaveLength(1);
});

it('refuses fallback pixels when a built-in exploring assertion requests semantic evidence', async () => {
  const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'must not see pixels' } }]);
  const pixelsOnly = defineEngine({ name: 'pixels-only', version: '1', spiVersion: 1, observe: async () => snapshot([{ ref: { id: 'root', revision: '' } }], { treeUnavailable: true, pixels: { data: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1, scale: 1 } }) });
  const { fixtures } = runtime(pixelsOnly, { agents: { default: { model } } });
  await expect(fixtures.agent.assert('inspect the screen', { explore: true, screenshot: false })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(loopCalls).toHaveLength(0);
});

it.each([
  { look: 'opening', code: 'POLICY_DENIED', modelCalls: 0 },
  { look: 'later', code: 'ASSERTION_INCONCLUSIVE', modelCalls: 2 },
])("handles a vision: 'only' exploring assertion whose $look look has no pixels", async ({ look, code, modelCalls }) => {
  let pixels = look === 'later';
  const screen = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async (_context, options) =>
      snapshot(
        [{ ref: { id: 'n1', revision: '' }, role: 'text', name: 'Ready' }],
        options?.pixels === true && pixels
          ? { pixels: { data: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 }
          : {},
      ),
  });
  const model = installFakeLoopModel(({ turn }) => {
    if (turn === 1) {
      pixels = false;
      return [{ toolName: 'observe', input: {} }];
    }
    return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'no pixels to judge', errorCode: 'ASSERTION_INCONCLUSIVE' } }];
  });
  const { fixtures } = runtime(screen, { agents: { default: { model } } });
  await expect(fixtures.agent.assert('the screen says Ready', { explore: true, vision: 'only' })).rejects.toMatchObject({ code });
  expect(loopCalls).toHaveLength(modelCalls);
  // A later look goes back to the model as the tool's error, without the tree.
  if (look === 'later') {
    expect(loopCalls[1]!.lastToolResult).toContain("vision: 'only' requires available pixel evidence");
    expect(loopCalls[1]!.lastToolResult).not.toContain('Ready');
  }
});
