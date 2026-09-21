import { describe, expect, it } from 'vitest';
import { AgentError, isAgentError } from '../../src/agent/error.ts';
import { setSecretRegistry } from '../../src/secrets.ts';
import { isSecret } from '../../src/locator/screen.ts';
import { CONSECUTIVE_FAILURE_LIMIT, createExploreBody } from '../../src/explore/body.ts';
import { ExploreState } from '../../src/explore/state.ts';
import type { Agent, App, TestFixtures } from '../../src/types.ts';

type PlanAnswer = { decision: 'step'; title: string; instruction: string } | { decision: 'finish'; summary: string };
type ActOutcome = { summary: string } | { throws: AgentError };

interface Script {
  /** Planner answers, in order; the instruction text of each call is recorded. */
  readonly plans: readonly PlanAnswer[];
  /** Act outcomes, in order. */
  readonly acts?: readonly ActOutcome[];
}

/** A fixture set whose agent replays a script and records what the body asked. */
function fixtures(script: Script, state: ExploreState) {
  const planInstructions: string[] = [];
  const actCalls: { instruction: string; timeout: number | undefined }[] = [];
  let plan = 0;
  let act = 0;
  const agent = {
    extract: async (instruction: string) => {
      planInstructions.push(instruction);
      const answer = script.plans[plan];
      plan += 1;
      if (answer === undefined) throw new Error(`unscripted planner call ${plan}`);
      return answer;
    },
    act: async (instruction: string, options?: { timeout?: number }) => {
      actCalls.push({ instruction, timeout: options?.timeout });
      const outcome = script.acts?.[act];
      act += 1;
      if (outcome === undefined) throw new Error(`unscripted act ${act}`);
      if ('throws' in outcome) throw outcome.throws;
      // Findings a real step would report through the tool land here.
      return { summary: outcome.summary, modelCalls: 3, actions: 2 };
    },
  } as unknown as Agent;
  const opened: string[] = [];
  const app = { open: async (target?: string) => void opened.push(target ?? '/') } as unknown as App;
  const body = createExploreBody({ state, stepTimeoutMs: 240_000, openApp: true });
  return {
    run: () => body({ agent, app, screen: {} as never, platform: 'web', stamp: 'e2estamp' } as TestFixtures),
    planInstructions,
    actCalls,
    opened,
  };
}

const budgets = { maxSteps: 4, timeoutMs: 600_000 };

describe('the exploration body', () => {
  it('opens the app, runs the planned steps, and finishes with the assessment', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'Cart', instruction: 'Add two items and open the cart' },
          { decision: 'step', title: 'Checkout', instruction: 'Pay for the cart' },
          { decision: 'finish', summary: 'Both flows work.' },
        ],
        acts: [{ summary: 'Cart holds two items' }, { summary: 'Paid' }],
      },
      state,
    );
    await harness.run();
    expect(harness.opened).toEqual(['/']);
    expect(harness.actCalls.map((call) => call.instruction)).toEqual(['Add two items and open the cart', 'Pay for the cart']);
    expect(harness.actCalls[0]!.timeout).toBe(240_000);
    expect(state.steps.map((step) => [step.title, step.status, step.summary])).toEqual([
      ['Cart', 'passed', 'Cart holds two items'],
      ['Checkout', 'passed', 'Paid'],
    ]);
    expect(state.summary).toBe('Both flows work.');
    expect(state.ended).toBe('finished');
  });

  it('keeps exploring after a failed step and fails the run only for issues', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'Pay', instruction: 'Pay for the cart' },
          { decision: 'step', title: 'Search', instruction: 'Search for shoes' },
          { decision: 'finish', summary: 'Payment is broken.' },
        ],
        acts: [
          { throws: new AgentError('ACTION_FAILED', 'agent.act failed: the pay button does nothing') },
          { summary: 'Search works' },
        ],
      },
      state,
    );
    await harness.run();
    expect(state.steps.map((step) => step.status)).toEqual(['failed', 'passed']);
    expect(state.steps[0]!.errorCode).toBe('ACTION_FAILED');
    expect(state.ended).toBe('finished');
  });

  it('treats a step that ran out of budget or time as ended, not failed', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'Long', instruction: 'Tour every page' },
          { decision: 'step', title: 'Slow', instruction: 'Wait for the report' },
          { decision: 'finish', summary: 'Covered.' },
        ],
        acts: [
          { throws: new AgentError('STEP_BUDGET_EXHAUSTED', 'agent.act blocked: out of actions', { blocked: true }) },
          { throws: new AgentError('STEP_TIMEOUT', 'agent.act blocked: out of time', { blocked: true }) },
        ],
      },
      state,
    );
    await harness.run();
    expect(state.steps.map((step) => step.status)).toEqual(['exhausted', 'exhausted']);
    expect(state.consecutiveFailures()).toBe(0);
  });

  it('asks for the assessment once steps keep failing, and records why it stopped', async () => {
    const state = new ExploreState('goal', { maxSteps: 8, timeoutMs: 600_000 });
    const failing = Array.from({ length: CONSECUTIVE_FAILURE_LIMIT }, (_, index) => ({
      decision: 'step' as const,
      title: `Try ${index + 1}`,
      instruction: `attempt ${index + 1}`,
    }));
    const harness = fixtures(
      {
        plans: [...failing, { decision: 'finish', summary: 'Nothing worked.' }],
        acts: [
          { throws: new AgentError('ACTION_FAILED', 'failed once') },
          { throws: new AgentError('AUTH_CREDENTIAL_UNAVAILABLE', 'no credential', { blocked: true }) },
          { throws: new AgentError('ASSERTION_FAILED', 'failed again') },
        ],
      },
      state,
    );
    await harness.run();
    expect(state.steps.map((step) => step.status)).toEqual(['failed', 'blocked', 'failed']);
    expect(harness.planInstructions.at(-1)).toContain('3 steps failed in a row without a finding; exploration is stuck');
    expect(state.ended).toBe('stuck');
    expect(state.summary).toBe('Nothing worked.');
  });

  it('stops at the step limit even when the planner proposes another step', async () => {
    const state = new ExploreState('goal', { maxSteps: 1, timeoutMs: 600_000 });
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'One', instruction: 'do the one thing' },
          { decision: 'step', title: 'Two', instruction: 'the model ignores the limit' },
        ],
        acts: [{ summary: 'done' }],
      },
      state,
    );
    await harness.run();
    expect(harness.actCalls).toHaveLength(1);
    expect(harness.planInstructions.at(-1)).toContain('the step limit of 1 is reached');
    expect(state.ended).toBe('step-limit');
    expect(state.summary).toBeUndefined();
  });

  it('caps a step at the time left and ends on the clock', async () => {
    let clock = 0;
    const state = new ExploreState('goal', { maxSteps: 8, timeoutMs: 300_000 }, () => clock);
    const planInstructions: string[] = [];
    const timeouts: (number | undefined)[] = [];
    let plans = 0;
    const agent = {
      extract: async (instruction: string) => {
        planInstructions.push(instruction);
        plans += 1;
        return plans === 1
          ? { decision: 'step', title: 'Tour', instruction: 'tour the app' }
          : { decision: 'finish', summary: 'Time is up.' };
      },
      act: async (_instruction: string, options?: { timeout?: number }) => {
        timeouts.push(options?.timeout);
        // The step eats most of the clock.
        clock += 200_000;
        return { summary: 'toured', modelCalls: 1, actions: 1 };
      },
    } as unknown as Agent;
    const app = { open: async () => undefined } as unknown as App;
    const body = createExploreBody({ state, stepTimeoutMs: 240_000, openApp: true, now: () => clock });
    await body({ agent, app, screen: {} as never, platform: 'web', stamp: 'e2estamp' } as TestFixtures);
    // 300 s left minus the 60 s finish reserve.
    expect(timeouts).toEqual([240_000]);
    expect(planInstructions).toHaveLength(2);
    expect(planInstructions[1]).toContain('the time budget is nearly spent');
    expect(state.ended).toBe('time');
    expect(state.summary).toBe('Time is up.');
  });

  it('skips app.open when told the target has no URL, and ends on the clock when a slow plan leaves no room for a step', async () => {
    let clock = 0;
    const state = new ExploreState('goal', { maxSteps: 8, timeoutMs: 300_000 }, () => clock);
    const opened: string[] = [];
    const acts: string[] = [];
    const agent = {
      extract: async () => {
        // The plan alone eats what was left above the reserve.
        clock += 240_000;
        return { decision: 'step', title: 'Late', instruction: 'too late to start' };
      },
      act: async (instruction: string) => {
        acts.push(instruction);
        return { summary: 'never', modelCalls: 1, actions: 1 };
      },
    } as unknown as Agent;
    const app = { open: async () => void opened.push('/') } as unknown as App;
    // Nothing ran and nothing was found, so the body concludes blocked; the clock is what this test is about.
    await expect(
      Promise.resolve().then(() => createExploreBody({ state, stepTimeoutMs: 240_000, openApp: false, now: () => clock })({ agent, app, screen: {} as never, platform: 'ios', stamp: 'e2estamp' } as TestFixtures)),
    ).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    expect(opened).toEqual([]);
    expect(acts).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.ended).toBe('time');
  });

  it('hands the configured credentials to every charter as secrets and tells the planner which accounts exist', async () => {
    setSecretRegistry({
      credentials: new Map([['ada', { name: 'ada', username: 'ada@example.test' }]]),
      secrets: new Map([['ada', { name: 'ada', purpose: 'password', value: 'bookworm' }]]),
    });
    try {
      const state = new ExploreState('goal', budgets);
      const planInstructions: string[] = [];
      const actParams: unknown[] = [];
      let plans = 0;
      const agent = {
        extract: async (instruction: string) => {
          planInstructions.push(instruction);
          plans += 1;
          return plans === 1 ? { decision: 'step', title: 'Sign in', instruction: 'sign in as ada' } : { decision: 'finish', summary: 'Signed in fine.' };
        },
        act: async (_instruction: string, options?: { params?: unknown }) => {
          actParams.push(options?.params);
          return { summary: 'signed in', modelCalls: 2, actions: 3 };
        },
      } as unknown as Agent;
      const app = { open: async () => undefined } as unknown as App;
      await createExploreBody({ state, stepTimeoutMs: 240_000, openApp: true, accounts: [{ name: 'ada', username: 'ada@example.test' }] })({ agent, app, screen: {} as never, platform: 'web', stamp: 'e2estamp' } as TestFixtures);
      expect(planInstructions[0]).toContain('- ada (username: ada@example.test)');
      expect(planInstructions[0]).not.toContain('bookworm');
      const params = actParams[0] as { credentials: { ada: { username: string; password: unknown } } };
      expect(params.credentials.ada.username).toBe('ada@example.test');
      expect(isSecret(params.credentials.ada.password)).toBe(true);
      expect(JSON.stringify(params)).not.toContain('bookworm');
    } finally {
      setSecretRegistry(undefined);
    }
  });

  it('fails the run for issues, naming them', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [{ decision: 'step', title: 'Cart', instruction: 'open the cart' }, { decision: 'finish', summary: 'Broken cart.' }],
        acts: [{ summary: 'cart opened' }],
      },
      state,
    );
    // The finding tool records findings during a step; here they are seeded ahead of the run.
    state.addFinding({ title: 'Total shows $0.00', kind: 'issue', severity: 4, expected: 'a total', actual: '$0.00', reproduction: ['open the cart'] });
    state.addFinding({ title: 'Icon misaligned', kind: 'warning', severity: 2, expected: 'aligned', actual: 'off by 2px', reproduction: ['look'] });
    await expect(harness.run()).rejects.toSatisfy(
      (error: unknown) =>
        isAgentError(error) &&
        error.code === 'ASSERTION_FAILED' &&
        error.message.includes('exploration found 1 issue(s): [severity 4] Total shows $0.00'),
    );
  });

  it('is blocked, never a pass, when nothing ran and nothing was found', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures({ plans: [{ decision: 'finish', summary: 'Nothing to explore here.' }] }, state);
    await expect(harness.run()).rejects.toSatisfy(
      (error: unknown) => isAgentError(error) && error.code === 'AUTOMATION_UNSUPPORTED' && error.blocked,
    );
    expect(state.ended).toBe('finished');
  });

  it.each([false, true])('keeps the first blocker when every charter was blocked, with warnings: %s', async (warning) => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'Account', instruction: 'Open the account' },
          { decision: 'step', title: 'Orders', instruction: 'Open the orders' },
          { decision: 'finish', summary: 'Neither area was reachable.' },
        ],
        acts: [
          { throws: new AgentError('AUTH_CREDENTIAL_UNAVAILABLE', 'Account needs a configured login', { blocked: true }) },
          { throws: new AgentError('ENVIRONMENT_UNAVAILABLE', 'Orders service is down', { blocked: true }) },
        ],
      },
      state,
    );
    if (warning) {
      state.addFinding({ title: 'Icon misaligned', kind: 'warning', severity: 2, expected: 'aligned', actual: 'off by 2px', reproduction: ['look'] });
    }
    await expect(harness.run()).rejects.toMatchObject({
      code: 'AUTH_CREDENTIAL_UNAVAILABLE',
      blocked: true,
      message: expect.stringContaining('Account needs a configured login'),
    });
    expect(state.steps.map((step) => step.status)).toEqual(['blocked', 'blocked']);
    expect(state.ended).toBe('finished');
  });

  it.each([
    { status: 'passed', outcome: { summary: 'Search works' } },
    { status: 'failed', outcome: { throws: new AgentError('ACTION_FAILED', 'Search could not complete') } },
    { status: 'exhausted', outcome: { throws: new AgentError('STEP_BUDGET_EXHAUSTED', 'Search reached its budget', { blocked: true }) } },
  ])('keeps the issues-only verdict after a $status charter and a blocked charter', async ({ status, outcome }) => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [
          { decision: 'step', title: 'Search', instruction: 'Search the catalog' },
          { decision: 'step', title: 'Account', instruction: 'Open the account' },
          { decision: 'finish', summary: 'Search was explored; account needs a login.' },
        ],
        acts: [outcome, { throws: new AgentError('AUTH_CREDENTIAL_UNAVAILABLE', 'No login configured', { blocked: true }) }],
      },
      state,
    );
    await harness.run();
    expect(state.steps.map((step) => step.status)).toEqual([status, 'blocked']);
  });

  it('fails for a reported issue even when every charter was blocked', async () => {
    const state = new ExploreState('goal', budgets);
    const harness = fixtures(
      {
        plans: [{ decision: 'step', title: 'Account', instruction: 'Open the account' }, { decision: 'finish', summary: 'Account was blocked.' }],
        acts: [{ throws: new AgentError('AUTH_CREDENTIAL_UNAVAILABLE', 'No login configured', { blocked: true }) }],
      },
      state,
    );
    state.addFinding({ title: 'Total shows $0.00', kind: 'issue', severity: 4, expected: 'a total', actual: '$0.00', reproduction: ['open the cart'] });
    await expect(harness.run()).rejects.toMatchObject({ code: 'ASSERTION_FAILED', blocked: false });
  });

  it('falls back to a survey when the first plan is not in the grammar, and stops on a later one', async () => {
    const invalid = () => new AgentError('MODEL_OUTPUT_INVALID', 'extracted data failed schema validation');
    const app = { open: async () => undefined } as unknown as App;
    const run = (state: ExploreState, agent: Agent) =>
      createExploreBody({ state, stepTimeoutMs: 240_000, openApp: true })({ agent, app, screen: {} as never, platform: 'web', stamp: 'e2estamp' } as TestFixtures);

    const first = new ExploreState('goal', budgets);
    let plans = 0;
    await run(first, {
      extract: async () => {
        plans += 1;
        if (plans === 1) throw invalid();
        return { decision: 'finish', summary: 'Surveyed.' };
      },
      act: async () => ({ summary: 'toured', modelCalls: 1, actions: 3 }),
    } as unknown as Agent);
    expect(first.steps.map((step) => step.title)).toEqual(['Survey the app']);
    expect(first.ended).toBe('finished');

    // One mid-run failure is covered by a continuation charter; a second in a row ends the exploration.
    const later = new ExploreState('goal', budgets);
    let laterPlans = 0;
    await run(later, {
      extract: async () => {
        laterPlans += 1;
        if (laterPlans === 1) return { decision: 'step', title: 'Cart', instruction: 'open the cart' };
        throw invalid();
      },
      act: async () => ({ summary: 'opened', modelCalls: 1, actions: 1 }),
    } as unknown as Agent);
    expect(later.steps.map((step) => step.title)).toEqual(['Cart', 'Continue exploring']);
    expect(later.ended).toBe('aborted');
    expect(later.summary).toBeUndefined();

    // A planner that recovers after one failure keeps going.
    const recovering = new ExploreState('goal', budgets);
    let recoveringPlans = 0;
    await run(recovering, {
      extract: async () => {
        recoveringPlans += 1;
        if (recoveringPlans === 1) return { decision: 'step', title: 'Cart', instruction: 'open the cart' };
        if (recoveringPlans === 2) throw invalid();
        if (recoveringPlans === 3) return { decision: 'step', title: 'Orders', instruction: 'open orders' };
        return { decision: 'finish', summary: 'Recovered and done.' };
      },
      act: async () => ({ summary: 'ok', modelCalls: 1, actions: 1 }),
    } as unknown as Agent);
    expect(recovering.steps.map((step) => step.title)).toEqual(['Cart', 'Continue exploring', 'Orders']);
    expect(recovering.ended).toBe('finished');

    // Asked to finish, the model answers outside the grammar: the run ends for its own reason, without an assessment.
    const closing = new ExploreState('goal', { maxSteps: 1, timeoutMs: 600_000 });
    let closingPlans = 0;
    await run(closing, {
      extract: async () => {
        closingPlans += 1;
        if (closingPlans === 1) return { decision: 'step', title: 'Only', instruction: 'the one step' };
        throw invalid();
      },
      act: async () => ({ summary: 'done', modelCalls: 1, actions: 1 }),
    } as unknown as Agent);
    expect(closing.steps).toHaveLength(1);
    expect(closing.ended).toBe('step-limit');
    expect(closing.summary).toBeUndefined();
  });

  it('surfaces a cancelled step and a planner failure as the run error', async () => {
    const cancelled = new ExploreState('goal', budgets);
    await expect(
      fixtures(
        {
          plans: [{ decision: 'step', title: 'Cart', instruction: 'open the cart' }],
          acts: [{ throws: new AgentError('CANCELLED', 'the step was cancelled') }],
        },
        cancelled,
      ).run(),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelled.steps[0]!.status).toBe('blocked');
    expect(cancelled.ended).toBe('aborted');

    const broken = new ExploreState('goal', budgets);
    const planner = fixtures({ plans: [] }, broken);
    await expect(planner.run()).rejects.toThrow(/unscripted planner call/);
    expect(broken.ended).toBe('aborted');
  });
});
