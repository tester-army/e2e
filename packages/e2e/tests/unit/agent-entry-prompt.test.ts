import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { WrittenScreenshots } from '../../src/run/screenshots.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(overrides: Partial<E2EConfig>, agentContext?: string, titlePath?: readonly string[]) {
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
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
    ...(titlePath === undefined ? {} : { test: { file: 'tests/billing.e2e.ts', titlePath, writtenScreenshots: new WrittenScreenshots('/tmp') } }),
  });
  return fixtures;
}

const conclude = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];

describe('the built-in agent from its agents entry', () => {
  it('puts system and context in the act prompt', async () => {
    const model = installFakeLoopModel(() => conclude);
    const fixtures = runtime({ agents: { default: { model, system: 'Be careful.', context: 'Plans are called tiers.' } } });
    await fixtures.agent.act('open billing');
    const system = loopCalls[0]!.system;
    expect(system).toContain('Be careful.');
    expect(system).toContain('Project context:\nPlans are called tiers.');
  });

  it('joins the context with the test-level agentContext', async () => {
    const model = installFakeLoopModel(() => conclude);
    const fixtures = runtime(
      { agents: { default: { model, context: 'Plans are called tiers.' } } },
      'Billing lives under Settings.',
    );
    await fixtures.agent.act('open billing');
    expect(loopCalls[0]!.system).toContain('Project context:\nPlans are called tiers.\nBilling lives under Settings.');
  });

  it("opens the context with the test's title path", async () => {
    const model = installFakeLoopModel(() => conclude);
    const fixtures = runtime(
      { agents: { default: { model, context: 'Plans are called tiers.' } } },
      'Billing lives under Settings.',
      ['billing', 'upgrades the plan'],
    );
    await fixtures.agent.act('open billing');
    expect(loopCalls[0]!.system).toContain(
      'Project context:\nTest: billing > upgrades the plan\nPlans are called tiers.\nBilling lives under Settings.',
    );
  });

  it('gives a judgment the title too', async () => {
    const judge = installFakeModel(() => judgment(true, 'shown'));
    const fixtures = runtime({ agents: { default: { model: judge } } }, undefined, ['billing', 'upgrades the plan']);
    await fixtures.agent.assert('the plan is upgraded');
    expect(fakeCalls[0]!.system).toContain('<project-context>\nTest: billing > upgrades the plan\n</project-context>');
  });

  it("builds each agent from its own entry: another agent's system never leaks in", async () => {
    const model = installFakeLoopModel(() => conclude);
    const fixtures = runtime({ agents: { default: { model, system: 'Be careful.' }, ux: { model, system: 'Review the layout.' } } });
    await fixtures.agent.act('open billing', { agent: 'ux' });
    expect(loopCalls[0]!.system).toContain('Review the layout.');
    expect(loopCalls[0]!.system).not.toContain('Be careful.');
  });
});
