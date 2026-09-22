import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src/agent/default-agent.ts';
import type { SdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(overrides: Partial<E2EConfig>, agentContext?: string) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
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
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return fixtures;
}

const conclude = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];

/** The scripted loop model, typed as the SDK model `createAgent` takes; it is one structurally. */
const loopModel = (): SdkLanguageModel => installFakeLoopModel(() => conclude) as SdkLanguageModel;

describe('createAgent({ context })', () => {
  it('reaches the act prompt exactly where agents.<name>.context does', async () => {
    const model = loopModel();
    const viaAgent = runtime({
      agents: { default: createAgent({ model, system: 'Be careful.', context: 'Plans are called tiers.' }) },
    });
    await viaAgent.agent.act('open billing');
    const agentSystem = loopCalls[0]!.system;
    expect(agentSystem).toContain('Be careful.');
    expect(agentSystem).toContain('Project context:\nPlans are called tiers.');

    loopModel();
    const viaConfig = runtime({
      agents: { default: { executor: createAgent({ system: 'Be careful.' }), model, context: 'Plans are called tiers.' } },
    });
    await viaConfig.agent.act('open billing');
    expect(loopCalls[0]!.system).toBe(agentSystem);
  });

  it('is joined with the test-level agentContext like the config key', async () => {
    const model = loopModel();
    const fixtures = runtime(
      { agents: { default: createAgent({ model, context: 'Plans are called tiers.' }) } },
      'Billing lives under Settings.',
    );
    await fixtures.agent.act('open billing');
    expect(loopCalls[0]!.system).toContain('Project context:\nPlans are called tiers.\nBilling lives under Settings.');
  });

  it('adds no project context when neither side names one', async () => {
    const model = loopModel();
    const fixtures = runtime({ agents: { default: createAgent({ model }) } });
    await fixtures.agent.act('open billing');
    expect(loopCalls[0]!.system).not.toContain('Project context:');
  });
});
