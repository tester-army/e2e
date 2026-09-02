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

const AGENT_SUITE = `import { test, expect } from 'e2e';

test('judgments and polling', async ({ app, agent, screen }) => {
  await app.open();
  await expect(screen.getByRole('status')).toHaveText('0');
  await agent.assert('the Home heading is visible');
  await agent.waitFor('the Late arrival button exists', { intervalMs: 100 });
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
    intervalMs: 100,
    timeout: 3000,
    maxModelCalls: 4,
  });
});

test('observes the token link page', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the About with token link is present');
});
`;

const FALSE_ASSERTION = 'the checkout page is visible';
const LATE_BUTTON_CONDITION = 'the Late arrival button exists';
const NEVER_CONDITION = 'a checkout button is on the About page';

/** Scripted responder: judge and extract from the observation. */
function respond(call: FakeCall): unknown {
  switch (call.schemaName) {
    case 'agent-judgment-1': {
      if (call.instruction === FALSE_ASSERTION) {
        return judgment(false, 'the observation shows the Home page, not checkout');
      }
      if (call.instruction === NEVER_CONDITION) return judgment(false, 'no checkout button here');
      if (call.instruction === LATE_BUTTON_CONDITION) {
        const present = call.observation.includes('Late arrival');
        return judgment(present, present ? 'Late arrival is present' : 'not rendered yet');
      }
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
    const model = installFakeModel(respond);
    const result = await runProject(
      { 'tests/agent.e2e.ts': AGENT_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
          agent: { model, context: 'This is the e2e fixture application.' },
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

  it('never exposes application-authored instructions as policy', () => {
    const system = fakeCalls[0]!.system;
    expect(system).toContain('policy-0.3');
    expect(system).toContain('This is the e2e fixture application.');
    expect(system.indexOf('policy-0.3')).toBeLessThan(
      system.indexOf('This is the e2e fixture application.'),
    );
  });

  it('sends the semantic tree with node references and no secret values', () => {
    const judged = fakeCalls.find((call) => call.schemaName === 'agent-judgment-1')!;
    expect(judged.observation).toContain('#n');
    expect(judged.observation).toContain('button "Increment"');
    expect(judged.observation).toContain('value=<secure>');
    expect(judged.revision).toMatch(/^b\d+$/);
  });

  it('discloses href origin and path only, never query strings or fragments', () => {
    // Query strings routinely carry tokens (spec 10-determinism.md).
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
    expect(judged.model).toMatchObject({
      provider: 'fake',
      model: 'scripted',
      endpoint: 'provider-default',
      policyVersion: 'policy-0.3',
      calls: 1,
      tokenAccounting: 'provider',
    });
    expect(judged.events.some((event) => event.kind === 'observation')).toBe(true);
    expect(judged.events.some((event) => event.kind === 'model')).toBe(true);
  });
});
