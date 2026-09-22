/**
 * Judgment-tier integration coverage: real Playwright observation, judgments,
 * polling, extraction, and report-1 agent step fields. The model is a
 * scripted adapter so the assertions stay deterministic. Planned flows
 * (`agent.act`) are covered by agent-act.test.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, judgment, type FakeCall } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
import { createAgent } from '../../src/agent/default-agent.ts';

const AGENT_SUITE = `import { test, expect } from 'e2e';

test('judgments and polling', async ({ app, agent, screen }) => {
  await app.open();
  await expect(screen.getByRole('status')).toHaveText('0');
  await agent.assert('the Home heading is visible');
  await agent.waitFor('the Late arrival button exists', { interval: 100 });
});

test('structured extraction', async ({ app, agent }) => {
  await app.open();
  const data = await agent.extract('the counter value', {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          typeof value === 'object' && value !== null && typeof value.counter === 'string'
            ? { value }
            : { issues: [{ message: 'counter must be a string' }] },
      },
    },
  });
  expect(data.counter).toBe('0');
});

test('a false judgment fails the assertion', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the checkout page is visible');
});

test('an inconclusive judgment fails the assertion too', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the order total equals the sum of the line items');
});

test('an inconclusive judgment that saw pixels is not pointed at vision', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the order total equals the sum of the line items', { vision: true });
});

test('a waitFor whose rounds stay inconclusive times out pointing at vision', async ({ app, agent, screen }) => {
  await app.open('/about');
  await expect(screen.getByRole('heading')).toHaveText('About');
  await agent.waitFor('the order total on the About page adds up', { interval: 100, timeout: 1500 });
});

test('waits without re-judging a page that has not changed', async ({
  app,
  agent,
  screen,
}) => {
  await app.open('/about');
  // Settle first, and assert it. Otherwise the first observation can catch a
  // document still being parsed, and the tree filling in afterwards is a real
  // change that legitimately earns a second judgment — which is not what this
  // test is about.
  await expect(screen.getByRole('heading')).toHaveText('About');
  // Budget for several judgments on purpose: the point is that a static page
  // never spends the second one.
  await agent.waitFor('a checkout button is on the About page', {
    interval: 100,
    timeout: 3000,
    maxModelCalls: 4,
  });
});

test('observes the token link page', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the About with token link is present');
});

test('a malformed judgment gets one repair round', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the Home heading is visible after a malformed first answer');
});

test('a judgment in the retired agent-judgment-1 shape is repaired once', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the Home heading is visible, answered in the retired shape first');
});

test('two judgments in the retired agent-judgment-1 shape exhaust the repair budget', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the Home heading is visible, answered in the retired shape twice');
});
`;

const FALSE_ASSERTION = 'the checkout page is visible';
const INCONCLUSIVE_ASSERTION = 'the order total equals the sum of the line items';
const INCONCLUSIVE_CONDITION = 'the order total on the About page adds up';
const VISION_HINT = 'the judge saw the semantic tree only; pass vision: true when the answer is in pixels';
const LATE_BUTTON_CONDITION = 'the Late arrival button exists';
const NEVER_CONDITION = 'a checkout button is on the About page';
const REPAIRED_ASSERTION = 'the Home heading is visible after a malformed first answer';
const RETIRED_SHAPE_ONCE = 'the Home heading is visible, answered in the retired shape first';
const RETIRED_SHAPE_TWICE = 'the Home heading is visible, answered in the retired shape twice';
/**
 * The document the deprecated `agent-judgment-v1` schema accepts, as a model
 * still answering in that shape would send it. The runner asks for
 * `agent-judgment-2` and takes nothing else.
 */
const RETIRED_JUDGMENT = JSON.parse(
  readFileSync(new URL('../../schema/fixtures/agent-judgment-v1.valid.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const PROVIDER_OPTIONS = { fake: { reasoningEffort: 'low' } };

/** Scripted responder: judge and extract from the observation. */
function respond(call: FakeCall): unknown {
  switch (call.schemaName) {
    case 'agent-judgment-2': {
      if (call.instruction === FALSE_ASSERTION) {
        return judgment(false, 'the observation shows the Home page, not checkout');
      }
      if (call.instruction === INCONCLUSIVE_ASSERTION) {
        return judgment('inconclusive', 'no order total or line items are on this screen');
      }
      if (call.instruction === INCONCLUSIVE_CONDITION) {
        return judgment('inconclusive', 'no order total is on the About page');
      }
      if (call.instruction === NEVER_CONDITION) return judgment(false, 'no checkout button here');
      if (call.instruction === LATE_BUTTON_CONDITION) {
        const present = call.observation.includes('Late arrival');
        return judgment(present, present ? 'Late arrival is present' : 'not rendered yet');
      }
      if (call.instruction === REPAIRED_ASSERTION) {
        // A reasoning model that ran out of output mid-answer: no verdict.
        const first = !fakeCalls.some(
          (earlier) => earlier !== call && earlier.instruction === REPAIRED_ASSERTION,
        );
        if (first) return { protocolVersion: 'agent-judgment-2', explanation: 'thinking' };
        return judgment(true, 'the Home heading is visible');
      }
      if (call.instruction === RETIRED_SHAPE_ONCE) {
        const first = !fakeCalls.some(
          (earlier) => earlier !== call && earlier.instruction === RETIRED_SHAPE_ONCE,
        );
        return first ? RETIRED_JUDGMENT : judgment(true, 'the Home heading is visible');
      }
      if (call.instruction === RETIRED_SHAPE_TWICE) return RETIRED_JUDGMENT;
      return judgment(true, 'the observation supports the assertion');
    }
    case 'agent-extract-1': {
      const status = call.lines.find((line) => line.includes('status'));
      const counter = /text="([^"]*)"/.exec(status ?? '')?.[1] ?? '';
      return { counter };
    }
    default:
      throw new Error(`unexpected schema ${call.schemaName}`);
  }
}

describe('agent judgment tier', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let report: Parameters<typeof assertValidReport>[0] & {
    run: { results: { attempts: { steps: import('../../src/report/build.ts').ReportStep[] }[] }[] };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    // The judge is a model of its own: every call in this suite is a judgment,
    // so every recorded call must have reached it and none the act model.
    const model = installFakeModel(respond, { modelId: 'actor' });
    const judge = installFakeModel(respond, { modelId: 'judge' });
    const result = await runProject(
      { 'tests/agent.e2e.ts': AGENT_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: {
            default: {
              model,
              judge,
              context: 'This is the e2e fixture application.',
              providerOptions: PROVIDER_OPTIONS,
            },
          },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
    report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as typeof report;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('runs judgments and polling against the real driver', () => {
    expect(resultByTitle(outcome, 'judgments and polling').status).toBe('passed');
  });

  it('spends one judgment while the page it is waiting on does not change', () => {
    // The condition is false and the About page is static, so re-judging could
    // only repeat the same answer. Every extra round would be a model call and
    // a few seconds, which is what made waiting on a real page sluggish.
    const title = 'waits without re-judging a page that has not changed';
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error?.code).toBe('STEP_TIMEOUT');
    const attempt = result.attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === 'agent.waitFor')!;
    expect(step.metrics!.modelCalls).toBe(1);
    // It kept looking, though: observations are driver-only and cost nothing.
    const observations = step.events.filter((event) => event.kind === 'observation').length;
    expect(observations).toBeGreaterThan(2);
  });

  it('repairs a malformed judgment with a second model call', () => {
    const result = resultByTitle(outcome, 'a malformed judgment gets one repair round');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.assert')!;
    expect(step.metrics!.modelCalls).toBe(2);
    const repairCalls = fakeCalls.filter((call) => call.instruction === REPAIRED_ASSERTION);
    expect(repairCalls).toHaveLength(2);
    expect(repairCalls[1]!.prompt).toContain('verdict must be "holds", "fails", or "inconclusive"');
  });

  it('repairs a judgment in the retired agent-judgment-1 shape once, naming the protocol version', () => {
    expect(RETIRED_JUDGMENT).toMatchObject({ protocolVersion: 'agent-judgment-1', result: true });
    const result = resultByTitle(outcome, 'a judgment in the retired agent-judgment-1 shape is repaired once');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.assert')!;
    expect(step.status).toBe('passed');
    expect(step.metrics!.modelCalls).toBe(2);
    expect(step.events.filter((event) => event.kind === 'schema')).toEqual([
      expect.objectContaining({ name: 'agent-judgment-2', status: 'failed', code: 'MODEL_OUTPUT_INVALID' }),
    ]);
    const calls = fakeCalls.filter((call) => call.instruction === RETIRED_SHAPE_ONCE);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).not.toContain('<previous-attempt-rejected>');
    expect(calls[1]!.prompt).toContain('validation errors: unknown protocolVersion');
    expect(calls[1]!.prompt).toContain('"protocolVersion":"agent-judgment-1"');
  });

  it('fails MODEL_OUTPUT_INVALID when the repair round answers in the retired shape too', () => {
    const result = resultByTitle(outcome, 'two judgments in the retired agent-judgment-1 shape exhaust the repair budget');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.category).toBe('test');
    expect(error.message).toContain('unknown protocolVersion');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.assert')!;
    expect(step.status).toBe('failed');
    // One judgment plus one repair round is the whole budget: no third call, no guessed verdict.
    expect(step.metrics!.modelCalls).toBe(2);
    expect(fakeCalls.filter((call) => call.instruction === RETIRED_SHAPE_TWICE)).toHaveLength(2);
    expect(step.events.filter((event) => event.kind === 'schema')).toHaveLength(2);
    // The rejection stands in for the verdict the step never got, so the report keeps its evidence rule.
    expect(step.explanation).toBe('unknown protocolVersion');
    expect(step.observationRevision).toMatch(/^b\d+$/);
  });

  it('leaves room for reasoning and sends provider options without pinning temperature', () => {
    const judged = fakeCalls.find((call) => call.schemaName === 'agent-judgment-2')!;
    expect(judged.settings.maxOutputTokens).toBe(8192);
    expect(judged.settings.temperature).toBeUndefined();
    expect(judged.settings.providerOptions).toEqual(PROVIDER_OPTIONS);
  });

  it('validates extracted data with Standard Schema v1', () => {
    expect(resultByTitle(outcome, 'structured extraction').status).toBe('passed');
  });

  it('fails the test with ASSERTION_FAILED on a false judgment', () => {
    const result = resultByTitle(outcome, 'a false judgment fails the assertion');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('ASSERTION_FAILED');
    expect(error.message).toContain('Home page, not checkout');
  });

  it('fails the test with ASSERTION_INCONCLUSIVE when the screen shows too little to judge', () => {
    // A judge that cannot see the evidence must not pass the step: a guess
    // in either direction is how a broken flow stays green.
    const result = resultByTitle(outcome, 'an inconclusive judgment fails the assertion too');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('ASSERTION_INCONCLUSIVE');
    expect(error.category).toBe('test');
    expect(error.message).toContain('no order total');
    // The judge read the tree alone and the viewport could still show pixels:
    // the remedy the docs give is named where the failure is read.
    expect(error.message).toContain(VISION_HINT);
  });

  it('leaves the vision hint off an inconclusive judgment that already saw pixels', () => {
    const result = resultByTitle(outcome, 'an inconclusive judgment that saw pixels is not pointed at vision');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('ASSERTION_INCONCLUSIVE');
    expect(error.message).toContain('no order total');
    expect(error.message).not.toContain('vision: true');
  });

  it('points a waitFor timeout at vision when its last round was inconclusive', () => {
    const result = resultByTitle(outcome, 'a waitFor whose rounds stay inconclusive times out pointing at vision');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('STEP_TIMEOUT');
    expect(error.message).toContain(`last judgment: no order total is on the About page; ${VISION_HINT}`);
  });

  it('routes every judgment to the judge model, never the act model', () => {
    expect(fakeCalls.length).toBeGreaterThan(4);
    for (const call of fakeCalls) expect(call.modelId).toBe('judge');
  });

  it('shows the judge the screen and the question, never the prior steps', () => {
    // 'judgments and polling' runs an assert and then a waitFor. The waitFor's
    // judgment must not carry the assert's label or explanation: a judge that
    // reads the actor's account of what happened is grading a story, not a
    // screen.
    const polled = fakeCalls.filter((call) => call.instruction === LATE_BUTTON_CONDITION);
    expect(polled.length).toBeGreaterThan(0);
    for (const call of polled) {
      expect(call.prompt).not.toContain('<ledger>');
      expect(call.prompt).not.toContain('the Home heading is visible');
      expect(call.prompt).not.toContain('the observation supports the assertion');
    }
    const steps = report.run.results.flatMap((result) => result.attempts).flatMap((attempt) => attempt.steps);
    for (const step of steps.filter((candidate) => candidate.kind === 'agent')) {
      expect(step.metrics!.ledgerBytes).toBe(0);
    }
  });

  it('never exposes application-authored instructions as policy', () => {
    const system = fakeCalls[0]!.system;
    expect(system).toContain('policy-0.3');
    expect(system).toContain('This is the e2e fixture application.');
    expect(system.indexOf('policy-0.3')).toBeLessThan(
      system.indexOf('This is the e2e fixture application.'),
    );
  });

  it('sends the semantic tree with node references and no secret values', () => {
    const judged = fakeCalls.find((call) => call.schemaName === 'agent-judgment-2')!;
    expect(judged.observation).toContain('#n');
    expect(judged.observation).toContain('button "Increment"');
    expect(judged.observation).toContain('value=<secure>');
    expect(judged.revision).toMatch(/^b\d+$/);
  });

  it('discloses href origin and path only, never query strings or fragments', () => {
    // Query strings routinely carry tokens.
    for (const call of fakeCalls) {
      expect(call.observation).not.toContain('super-secret-token');
      expect(call.observation).not.toContain('#frag');
    }
    const withLink = fakeCalls.find((call) => call.observation.includes('About with token'))!;
    expect(withLink.observation).toContain('/about');
  });

  it('writes a schema-valid report with agent metrics and model provenance', () => {
    assertValidReport(report);
    const steps = report.run.results
      .flatMap((result) => result.attempts)
      .flatMap((attempt) => attempt.steps);
    const agentSteps = steps.filter((step) => step.kind === 'agent');
    expect(agentSteps.length).toBeGreaterThan(4);
    for (const step of agentSteps) {
      expect(step.metrics).toBeDefined();
    }
    const judged = agentSteps.find((step) => step.api === 'agent.assert')!;
    expect(judged.metrics).toMatchObject({ modelCalls: 1, actionSteps: 0 });
    expect(judged.metrics!.observationBytes).toBeGreaterThan(0);
    // Provenance names the judge, the model this verdict actually came from.
    expect(judged.model).toMatchObject({
      provider: 'fake',
      model: 'judge',
      endpoint: 'provider-default',
      policyVersion: 'policy-0.3',
      calls: 1,
      tokenAccounting: 'provider',
    });
    expect(judged.events.some((event) => event.kind === 'observation')).toBe(true);
    expect(judged.events.some((event) => event.kind === 'model')).toBe(true);
  });
});

describe('createAgent with a judge', () => {
  const SUITE = `import { test } from 'e2e';

test('the judge judges createAgent assertions', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the Home heading is visible');
  await agent.assert('the checkout page is visible');
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // `createAgent(...)` is a StepExecutor, but it is the built-in agent, not a
    // custom brain. Its assertions must reach the judgment tier and the judge,
    // not its own act loop on the actor model.
    const actor = installFakeModel(respond, { modelId: 'actor' });
    const judge = installFakeModel(respond, { modelId: 'judge' });
    const result = await runProject(
      { 'tests/judge.e2e.ts': SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: createAgent({ model: actor as never, judge: judge as never }) } } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('sends both assertions to the judge as single judgments and fails on the false one', () => {
    const result = resultByTitle(outcome, 'the judge judges createAgent assertions');
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error?.code).toBe('ASSERTION_FAILED');
    const judged = fakeCalls.filter((call) => call.schemaName === 'agent-judgment-2');
    expect(judged).toHaveLength(2);
    for (const call of judged) expect(call.modelId).toBe('judge');
    const steps = result.attempts.at(-1)!.steps.filter((step) => step.api === 'agent.assert');
    expect(steps.map((step) => step.status)).toEqual(['passed', 'failed']);
    for (const step of steps) expect(step.model).toMatchObject({ model: 'judge', calls: 1 });
  });
});
