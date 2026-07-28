/**
 * Agent integration coverage: real Playwright observation, runner-owned locate
 * validation, real driver actions, and report-1 agent step fields. The model is
 * a scripted adapter so the assertions stay deterministic.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  judgment,
  locateBestMatch,
  locateNotFound,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
import type { ReportStep } from '../../src/report/build.ts';

const AGENT_SUITE = `import { test, expect } from 'e2e';

test('located actions and judgments', async ({ app, agent, screen }) => {
  await app.open();

  await agent.tap('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('1');

  await agent.click('the Increment button');
  await expect(screen.getByRole('status')).toHaveText('2');

  await agent.type('the Email field', 'user@example.test');
  await expect(screen.getByLabel('Email')).toHaveValue('user@example.test');

  await agent.longPress('the Menu button', { durationMs: 150 });

  await agent.scroll({ direction: 'down' });
  await agent.scrollTo('the Item Gamma list item');

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

test('located verbs drive the verbs playground', async ({ app, agent, screen }) => {
  await app.open('/verbs');

  await agent.type('the Search field', 'quarterly report');
  await agent.press('the Search field', 'Enter');
  await expect(screen.getByLabel('Submitted')).toHaveText('submitted:quarterly report');

  await agent.hover('the Hover zone');
  await expect(screen.getByRole('button', { name: 'Revealed action' })).toBeVisible();

  await agent.dragTo('the Card One item', 'the Drop zone');
  await expect(screen.getByLabel('Drop state')).toHaveText('dropped');

  await agent.upload('the Avatar upload field', 'avatar.txt');
  await expect(screen.getByLabel('File name')).toHaveText('avatar.txt');
});

test('select and check drive native form controls', async ({ app, agent, screen }) => {
  await app.open();
  await agent.select('the Plan dropdown', 'Pro');
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await agent.check('the Notifications checkbox');
  await expect(screen.getByLabel('Notifications')).toBeChecked();
  await agent.uncheck('the Notifications checkbox');
  await expect(screen.getByLabel('Notifications')).not.toBeChecked();
});

test('located actions reach nodes inside iframes', async ({ app, agent, web }) => {
  await app.open('/frame');
  await agent.tap('the Frame button');
  await expect(web.frameLocator('#child').getByRole('button')).toHaveText('Frame clicked');
});

test('an explicit no-match fails with the model explanation', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the shopping cart icon');
});
`;

const FALSE_ASSERTION = 'the checkout page is visible';
const LATE_BUTTON_CONDITION = 'the Late arrival button exists';
const NO_MATCH_TARGET = 'the shopping cart icon';
const NO_MATCH_EXPLANATION = 'the observation shows a counter demo without any cart icon';

/** Scripted responder: locate by best line match, judge from the observation. */
function respond(call: FakeCall): unknown {
  switch (call.schemaName) {
    case 'agent-locate-1':
      if (call.instruction === NO_MATCH_TARGET) return locateNotFound(NO_MATCH_EXPLANATION);
      return locateBestMatch(call);
    case 'agent-judgment-1': {
      if (call.instruction === FALSE_ASSERTION) {
        return judgment(false, 'the observation shows the Home page, not checkout');
      }
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

describe('agent fixture', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let report: { run: { results: { attempts: { steps: ReportStep[] }[] }[]; usage: Record<string, number> } };

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const result = await runProject(
      { 'tests/agent.e2e.ts': AGENT_SUITE, 'avatar.txt': 'fixture upload payload' },
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

  it('runs located actions, polling, and judgments against the real driver', () => {
    expect(resultByTitle(outcome, 'located actions and judgments').status).toBe('passed');
  });

  it('validates extracted data with Standard Schema v1', () => {
    expect(resultByTitle(outcome, 'structured extraction').status).toBe('passed');
  });

  it('drives press, hover, dragTo, and upload through located verbs', () => {
    expect(resultByTitle(outcome, 'located verbs drive the verbs playground').status).toBe(
      'passed',
    );
  });

  it('drives native select and checkbox controls', () => {
    expect(resultByTitle(outcome, 'select and check drive native form controls').status).toBe(
      'passed',
    );
  });

  it('locates and acts on nodes inside iframes', () => {
    expect(resultByTitle(outcome, 'located actions reach nodes inside iframes').status).toBe(
      'passed',
    );
  });

  it('fails the test with ASSERTION_FAILED on a false judgment', () => {
    const result = resultByTitle(outcome, 'a false judgment fails the assertion');
    expect(result.status).toBe('failed');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    expect(attempt.error?.category).toBe('test');
    expect(attempt.error?.message).toContain('not checkout');
  });

  it('surfaces the model explanation when it reports an explicit no-match', () => {
    const result = resultByTitle(outcome, 'an explicit no-match fails with the model explanation');
    expect(result.status).toBe('failed');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(attempt.error?.category).toBe('test');
    expect(attempt.error?.message).toContain(NO_MATCH_TARGET);
    expect(attempt.error?.message).toContain(NO_MATCH_EXPLANATION);
  });

  it('never exposes application-authored instructions as policy', () => {
    const system = fakeCalls[0]!.system;
    expect(system).toContain('policy-0.2');
    expect(system).toContain('This is the e2e fixture application.');
    expect(system.indexOf('policy-0.2')).toBeLessThan(
      system.indexOf('This is the e2e fixture application.'),
    );
  });

  it('sends the semantic tree with node references and no secret values', () => {
    const locate = fakeCalls.find((call) => call.schemaName === 'agent-locate-1')!;
    expect(locate.observation).toContain('#n');
    expect(locate.observation).toContain('button "Increment"');
    expect(locate.observation).toContain('value=<secure>');
    expect(locate.revision).toMatch(/^r\d+$/);
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
    expect(agentSteps.length).toBeGreaterThan(8);
    for (const step of agentSteps) {
      expect(step.metrics).toBeDefined();
      expect(step.cache).toEqual({ status: 'bypassed' });
    }

    const tap = agentSteps.find((step) => step.api === 'agent.tap')!;
    expect(tap.metrics).toMatchObject({ modelCalls: 1, actionSteps: 1 });
    expect(tap.metrics!.observationBytes).toBeGreaterThan(0);
    expect(tap.model).toMatchObject({
      provider: 'fake',
      model: 'scripted',
      endpoint: 'provider-default',
      policyVersion: 'policy-0.2',
      calls: 1,
      tokenAccounting: 'provider',
    });
    expect(tap.events.some((event) => event.kind === 'observation')).toBe(true);
    expect(tap.events.some((event) => event.kind === 'model')).toBe(true);
    expect(tap.events.some((event) => event.kind === 'driver')).toBe(true);

    const scroll = agentSteps.find((step) => step.api === 'agent.scroll')!;
    expect(scroll.metrics).toMatchObject({ modelCalls: 0, actionSteps: 1 });
    expect(scroll.model).toBeUndefined();

    const assertion = agentSteps.find((step) => step.api === 'agent.assert')!;
    expect(assertion.observationRevision).toBeDefined();
    expect(assertion.explanation).toBeDefined();
    expect(assertion.artifacts).toHaveLength(1);

    expect(report.run.usage.maxModelCallsInStep).toBeGreaterThan(0);
    expect(report.run.usage.modelTokens).toBeGreaterThan(0);
    expect(report.run.usage.events).toBeGreaterThan(0);
    expect(report.run.usage.maxAgentContextBytes).toBeGreaterThan(0);
  });
});
