/**
 * Planning-tier coverage for `agent.act` against a real browser.
 *
 * The scripted planner reads the observation to choose each action, so it is
 * scripted in what it concludes, not in which node it names: a fake with
 * hard-coded node ids would pass while proving nothing about the loop.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  toolCall,
  toolConclude,
  toolOnMatch,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProject,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const SUITE = `import { test, expect, credentials } from 'e2e';

test('completes a multi-step flow', async ({ web, agent, screen }) => {
  await web.goto('/onboarding');
  await agent.act('complete the onboarding for a company called Acme Inc');
  await expect(screen.getByRole('heading', { name: 'You are all set' })).toBeVisible();
  await expect(screen.getByLabel('Stage')).toHaveText('done');
});

test('returns validated structured data', async ({ web, agent }) => {
  await web.goto('/onboarding');
  const result = await agent.act('read the current stage', undefined, {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          typeof value === 'object' && value !== null && typeof value.stage === 'string'
            ? { value }
            : { issues: [{ message: 'stage must be a string', path: ['stage'] }] },
      },
    },
  });
  expect(result.ok).toBe(true);
  expect(result.data.stage).toBe('welcome');
});

test('fills a secret without disclosing it', async ({ app, agent }) => {
  await app.open();
  await agent.act('sign in', { password: credentials.user('admin').password });
});

test('navigates only where the policy allows', async ({ app, agent, web }) => {
  await app.open();
  await agent.act('go to the about page');
  expect(new URL(await web.url()).pathname).toBe('/about');
});

test('a denied navigation fails the step', async ({ app, agent }) => {
  await app.open();
  await agent.act('go to the external partner site');
});

test('a model conclusion of failure fails the step', async ({ app, agent }) => {
  await app.open();
  await agent.act('do the impossible thing');
});

test('recovers when challenged on a premature failure', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('give up once, then increment');
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('routes around a failed action', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter, working around a stale target');
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('concludes despite a stray field', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap increment then finish untidily');
});

test('gives up on an unproductive repair loop', async ({ app, agent }) => {
  await app.open();
  await agent.act('answer with something invalid forever');
});

test('escalates to a screenshot when the tree was not enough', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment, but only once you can see the page', undefined, { vision: 'fallback' });
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('refuses to plan from the screenshot alone', async ({ app, agent }) => {
  await app.open();
  await agent.act('do anything', undefined, { vision: 'only' });
});

test('rejects an instruction that is not a string', async ({ app, agent }) => {
  await app.open();
  // @ts-expect-error the point is what a JavaScript caller can do
  await agent.act(42);
});

test('survives a node the page replaced mid-dispatch', async ({ web, agent, screen }) => {
  await web.goto('/restage');
  await agent.act('continue', undefined, { maxSteps: 2 });
  await expect(screen.getByLabel('State')).toHaveText('continued');
});

test('refuses to loop without concluding', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap the same inert heading forever');
});

test('stops when the step budget runs out', async ({ app, agent }) => {
  await app.open();
  await agent.act('keep incrementing and never finish', undefined, { maxSteps: 2 });
});

test('reports what happened when it runs out of actions', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment until the budget runs out, then say so', undefined, { maxSteps: 2 });
});
`;

const ONBOARDING = 'complete the onboarding for a company called Acme Inc';
const READ_STAGE = 'read the current stage';
const SIGN_IN = 'sign in';
const GO_ABOUT = 'go to the about page';
const GO_EXTERNAL = 'go to the external partner site';
const IMPOSSIBLE = 'do the impossible thing';
const GIVES_UP_ONCE = 'give up once, then increment';
/** The runner's recovery challenge, quoted so the fake reacts to the real text. */
const CHALLENGE = 'Before that is accepted, look once more';
const ROUTE_AROUND = 'increment the counter, working around a stale target';
const UNTIDY = 'tap increment then finish untidily';
const ALWAYS_INVALID = 'answer with something invalid forever';
const ESCALATES = 'increment, but only once you can see the page';
const RESTAGED = 'continue';
const LOOP_FOREVER = 'tap the same inert heading forever';
const NEVER_FINISH = 'keep incrementing and never finish';
const WINDS_DOWN = 'increment until the budget runs out, then say so';
/** The runner's wind-down notice, quoted so the fake reacts to the real text. */
const NO_ACTIONS_LEFT = 'You have no actions left';

let rounds: Record<string, number> = {};

function round(call: FakeCall): number {
  const next = (rounds[call.instruction] ?? 0) + 1;
  rounds[call.instruction] = next;
  return next;
}

/**
 * The onboarding branch decides purely from the observation which step the page
 * is on, so the loop has to genuinely re-observe for it to ever reach the end.
 */
function respond(call: FakeCall): unknown {
  if (call.schemaName !== 'agent-tool-1') {
    throw new Error(`unexpected schema ${call.schemaName}`);
  }
  const attempt = round(call);
  switch (call.instruction) {
    case ONBOARDING:
      return planOnboarding(call);
    case READ_STAGE: {
      const stage = /aria-?label.*Stage|Stage/.test(call.observation)
        ? (/text="([^"]*)"/.exec(call.lines.find((line) => line.includes('status')) ?? '')?.[1] ?? '')
        : '';
      // The first conclusion is the wrong shape on purpose.
      return attempt === 1
        ? toolConclude('read it', { data: { stage: 42 } })
        : toolConclude('read it', { data: { stage } });
    }
    case SIGN_IN:
      return attempt === 1
        ? toolOnMatch(call, /purpose=password/, 'type', {
            sensitiveName: 'admin',
            purpose: 'password',
          })
        : toolConclude('filled the password field');
    case GO_ABOUT:
      return attempt === 1
        ? toolCall('navigate', { url: '/about' })
        : toolConclude('landed on the about page');
    case GO_EXTERNAL:
      return toolCall('navigate', { url: 'https://partner.example.com/login' });
    case IMPOSSIBLE:
      // Insists, so the second conclusion is accepted as the result.
      return toolConclude('the observation shows no such feature on this screen', {
        status: 'failure',
      });
    case GIVES_UP_ONCE:
      if (call.prompt.includes(CHALLENGE)) return toolOnMatch(call, /Increment/, 'tap');
      return attempt === 1
        ? toolConclude('the Increment button looks disabled', { status: 'failure' })
        : toolConclude('the counter reads 1');
    case ROUTE_AROUND:
      // Well-formed and current-revision, but names nothing.
      if (attempt === 1) {
        return toolCall('tap', { target: { id: 'n99999', revision: call.revision } });
      }
      return attempt === 2
        ? toolOnMatch(call, /Increment/, 'tap')
        : toolConclude('the counter reads 1');
    case UNTIDY:
      // Every field the flat schema declares, the way a real provider answers.
      return attempt === 1
        ? { ...(toolOnMatch(call, /Increment/, 'tap') as object), value: '', key: '', url: '' }
        : { ...(toolConclude('the counter reads 1') as object), value: '', key: 'Enter' };
    case ALWAYS_INVALID:
      return toolCall('conclude', { status: 'maybe', explanation: 'unsure' });
    case ESCALATES:
      // Gives up first, which is the signal `'fallback'` waits for. The challenge
      // that follows should carry pixels the first attempt did not have.
      if (attempt === 1) {
        return toolConclude('the tree does not show whether the page rendered', {
          status: 'failure',
        });
      }
      return call.images.length > 0 && attempt === 2
        ? toolOnMatch(call, /Increment/, 'tap')
        : toolConclude('the counter reads 1');
    case RESTAGED:
      return call.observation.includes('"continued"')
        ? toolConclude('the state reads continued')
        : toolOnMatch(call, /Continue/, 'tap');
    case LOOP_FOREVER:
      // The heading is inert, so the screen is identical every round: nothing
      // but repetition detection can end this.
      return toolOnMatch(call, /heading "Home"/, 'tap');
    case NEVER_FINISH:
      // Refuses to conclude even when told to, so the model-call budget is the
      // only thing left to stop it.
      if (call.prompt.includes(NO_ACTIONS_LEFT)) return toolCall('observe');
      // Alternating targets, so repetition detection cannot fire first.
      return toolOnMatch(call, attempt % 2 === 1 ? /Increment/ : /Menu/, 'tap');
    case WINDS_DOWN:
      return call.prompt.includes(NO_ACTIONS_LEFT)
        ? toolConclude('the counter moved but the flow was not finished', { status: 'failure' })
        : toolOnMatch(call, attempt % 2 === 1 ? /Increment/ : /Menu/, 'tap');
    default:
      // Both the vision: 'only' and bad-argument tests fail before any model
      // call, so reaching here for them would be the bug.
      throw new Error(`unscripted instruction ${JSON.stringify(call.instruction)}`);
  }
}

/** Chooses the next onboarding action from whatever the screen currently shows. */
function planOnboarding(call: FakeCall): unknown {
  if (call.observation.includes('You are all set')) {
    return toolConclude('the summary confirms Acme Inc with the digest on');
  }
  if (call.observation.includes('Get started')) {
    return toolOnMatch(call, /Get started/, 'tap');
  }
  if (call.observation.includes('Company name')) {
    const filled = /Company name.*value="Acme Inc"/.test(call.observation);
    return filled
      ? toolOnMatch(call, /Continue/, 'tap')
      : toolOnMatch(call, /Company name/, 'type', { value: 'Acme Inc' });
  }
  if (call.observation.includes('Email digest')) {
    const checked = /Email digest.*\[[^\]]*checked/.test(call.observation);
    return checked
      ? toolOnMatch(call, /Finish setup/, 'tap')
      : toolOnMatch(call, /Email digest/, 'tap');
  }
  return toolConclude('the screen no longer matches any onboarding step', { status: 'failure' });
}

describe('agent.act', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    rounds = {};
    const model = installFakeModel(respond);
    const result = await runProject(
      { 'tests/act.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
          agent: { model },
          credentials: { admin: { username: 'admin', password: 'correct horse' } },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
    assertValidReport(
      JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')),
    );
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const actStep = (title: string) => {
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.act');
    if (step === undefined) throw new Error(`no agent.act step in "${title}"`);
    return step;
  };

  it('completes a flow no single action could finish', () => {
    expect(resultByTitle(outcome, 'completes a multi-step flow').status).toBe('passed');
  });

  it('commits one action per planning round and re-observes between them', () => {
    const step = actStep('completes a multi-step flow');
    expect(step.metrics!.actionSteps).toBeGreaterThanOrEqual(5);
    expect(step.metrics!.modelCalls).toBeGreaterThan(step.metrics!.actionSteps);
    const observations = step.events.filter((event) => event.kind === 'observation');
    expect(observations.length).toBeGreaterThanOrEqual(5);
  });

  it('tells the model what it has already done', () => {
    const calls = fakeCalls.filter((call) => call.instruction === ONBOARDING);
    expect(calls[0]?.trail).toBe('');
    const last = calls.at(-1);
    expect(last?.trail).toContain('tapped');
    expect(last?.trail).toContain('Get started');
    expect(last?.trail).toContain('typed "Acme Inc"');
  });

  it('validates conclusion data against the caller schema and repairs it', () => {
    const test = resultByTitle(outcome, 'returns validated structured data');
    expect(test.status).toBe('passed');
    const step = actStep('returns validated structured data');
    expect(step.events.some((event) => event.kind === 'schema')).toBe(true);
  });

  it('fills a pinned secret and never sends its value to the model', () => {
    expect(resultByTitle(outcome, 'fills a secret without disclosing it').status).toBe('passed');
    // A secure value is never readable back, so the commit is the only proof.
    expect(
      actStep('fills a secret without disclosing it').metrics!.actionSteps,
    ).toBeGreaterThanOrEqual(1);
    for (const call of fakeCalls) {
      expect(call.prompt).not.toContain('correct horse');
      expect(call.system).not.toContain('correct horse');
    }
    const signIn = fakeCalls.find((call) => call.instruction === SIGN_IN);
    expect(signIn?.params).toContain('admin');
    expect(signIn?.params).toContain('password');
  });

  it('navigates to an allowed origin', () => {
    expect(resultByTitle(outcome, 'navigates only where the policy allows').status).toBe('passed');
  });

  it('denies a navigation outside allowedOrigins before dispatching it', () => {
    const test = resultByTitle(outcome, 'a denied navigation fails the step');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
    expect(actStep('a denied navigation fails the step')!.metrics!.actionSteps).toBe(0);
  });

  // Most give-ups are one obstacle away from working, and the model has usually
  // not looked. A single challenge costs one round on a genuine dead end.
  it('questions a premature failure once, and takes the recovery', () => {
    const title = 'recovers when challenged on a premature failure';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = actStep(title);
    expect(step.metrics!.actionSteps).toBe(1);
    const asked = fakeCalls.filter((call) => call.instruction === GIVES_UP_ONCE);
    expect(asked.some((call) => call.prompt.includes(CHALLENGE))).toBe(true);
  });

  it('accepts a failure the model stands behind, without challenging twice', () => {
    const asked = fakeCalls.filter((call) => call.instruction === IMPOSSIBLE);
    expect(asked.filter((call) => call.prompt.includes(CHALLENGE))).toHaveLength(1);
  });

  it('fails the step when the model concludes failure', () => {
    const test = resultByTitle(outcome, 'a model conclusion of failure fails the step');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('ACTION_FAILED');
    expect(actStep('a model conclusion of failure fails the step')!.explanation).toContain(
      'no such feature',
    );
  });

  it('hands a rejected target back for repair instead of failing the flow', () => {
    expect(resultByTitle(outcome, 'routes around a failed action').status).toBe('passed');
    const step = actStep('routes around a failed action');
    expect(step.events.some((event) => event.kind === 'schema')).toBe(true);
  });

  // A flat request schema declares every kind's fields together, and models fill
  // them in. Rejecting the strays stalled a flow that had already decided right.
  it('tolerates fields the chosen kind does not take', () => {
    const test = resultByTitle(outcome, 'concludes despite a stray field');
    expect(test.status).toBe('passed');
    const step = actStep('concludes despite a stray field');
    expect(step.metrics!.actionSteps).toBe(1);
    // Two calls: the tap and the conclusion. No repair rounds.
    expect(step.metrics!.modelCalls).toBe(2);
    expect(step.events.some((event) => event.kind === 'schema')).toBe(false);
  });

  // Re-asking a model that returns the identical rejection only spends the
  // budget a few seconds at a time before failing with the same message.
  it('abandons a repair loop that repeats itself instead of draining the budget', () => {
    const test = resultByTitle(outcome, 'gives up on an unproductive repair loop');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('MODEL_OUTPUT_INVALID');
    // Two attempts, not the configured 25.
    expect(actStep('gives up on an unproductive repair loop').metrics!.modelCalls).toBe(2);
  });

  // The page replaced the node between the observation and the dispatch. Nothing
  // ran and the decision was right, so it costs neither an action step nor a
  // "try something else" — a page that restages on every interaction would
  // otherwise exhaust maxSteps without ever acting.
  it('retries a dispatch the page invalidated, without spending a step', () => {
    const title = 'survives a node the page replaced mid-dispatch';
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    if (attempt.error) throw new Error(`${attempt.error.code}: ${attempt.error.message}`);
    expect(resultByTitle(outcome, title).status).toBe('passed');
    // One tap landed. The refund is what keeps this inside a budget of 2.
    expect(actStep(title).metrics!.actionSteps).toBe(1);
  });

  // `'fallback'` used to be a silent no-op for planning: nothing in the loop ever
  // escalated, so the option attached pixels only for located actions.
  it("escalates vision: 'fallback' once the model reports the tree fell short", () => {
    const title = 'escalates to a screenshot when the tree was not enough';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const asked = fakeCalls.filter((call) => call.instruction === ESCALATES);
    expect(asked[0]?.images).toHaveLength(0);
    expect(asked.slice(1).some((call) => call.images.length > 0)).toBe(true);
    expect(actStep(title).visionEscalated).toBe(true);
  });

  // `'only'` withholds the tree, and planning has to name nodes from it. Allowed
  // through, every proposal would be rejected until the budget was gone.
  it("refuses vision: 'only' before spending a model call", () => {
    const title = 'refuses to plan from the screenshot alone';
    const test = resultByTitle(outcome, title);
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
    expect(actStep(title).metrics!.modelCalls).toBe(0);
  });

  // A malformed argument is the test author's mistake, so it fails that test
  // rather than reporting a configuration problem and changing the exit code.
  it('reports a bad argument as an argument error, not a policy denial', () => {
    const attempt = resultByTitle(outcome, 'rejects an instruction that is not a string').attempts.at(-1)!;
    expect(attempt.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('refuses to repeat one action against an unchanged screen', () => {
    const test = resultByTitle(outcome, 'refuses to loop without concluding');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('STEP_NO_CONCLUSION');
  });

  // A multi-action flow that fails is unreadable without knowing how far it got:
  // the raised error only names whatever operation was running at the time.
  it('reports what the flow did on every kind of failure', () => {
    for (const [title, expected] of [
      ['refuses to loop without concluding', 'tapped'],
      ['stops when the step budget runs out', 'tapped'],
      ['a model conclusion of failure fails the step', 'gave up'],
    ] as const) {
      const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
      expect(attempt.error?.message, `${title} message`).toContain('planning round');
      expect(attempt.error?.message, `${title} trail`).toContain(expected);
      // Kept on the step too, so the report has it after the output scrolls by.
      expect(actStep(title).explanation, `${title} explanation`).toContain('planning round');
    }
  });

  it('stops at the action-step budget rather than guessing success', () => {
    const test = resultByTitle(outcome, 'stops when the step budget runs out');
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('STEP_BUDGET_EXHAUSTED');
    expect(actStep('stops when the step budget runs out')!.metrics!.actionSteps).toBe(2);
  });

  // An invocation out of actions is offered only `observe` and `conclude`, so it
  // reports what it found instead of being cut off by a bare budget error.
  it('forces a conclusion once the actions are spent', () => {
    const title = 'reports what happened when it runs out of actions';
    const test = resultByTitle(outcome, title);
    expect(test.status).toBe('failed');
    expect(test.attempts.at(-1)!.error?.code).toBe('ACTION_FAILED');
    const step = actStep(title);
    expect(step.metrics!.actionSteps).toBe(2);
    expect(step.explanation).toContain('not finished');
    // The narrowed grammar is what makes it structural rather than a request.
    const last = fakeCalls.findLast((call) => call.instruction === WINDS_DOWN);
    expect(last?.prompt).toContain(NO_ACTIONS_LEFT);
    expect(last?.prompt).not.toContain('kind "tap"');
  });

  it('records the planning tier as a model-backed step', () => {
    const step = actStep('completes a multi-step flow');
    expect(step!.model).toMatchObject({
      provider: 'fake',
      model: 'scripted',
      policyVersion: 'policy-0.3',
    });
  });

  // A denied navigation is a configuration failure, not a test failure, and the
  // run reports the most severe category it saw (spec 06-cli.md).
  it('reports the most severe failure category as the exit code', () => {
    expect(outcome.exitCode).toBe(2);
  });
});
