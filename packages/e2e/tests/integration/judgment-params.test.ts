/**
 * `agent.assert` and `agent.waitFor` take `params` as `agent.act` does: the
 * judge reads a `unique()` value as its string and a `Secret` by name only,
 * on the built-in judgment tier and through a custom executor alike.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SECRET_VALUE = 'hunter2-secret';
/** A registered value with a quote, so the judge prompt's JSON spells it escaped. */
const QUOTED_SECRET = 'pa"ss-7781';

const SUITE = `import { test, credentials, unique } from 'e2e';

test('assert reads a unique value', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the table shows company {name} on the {plan} plan', {
    params: { name: unique('acme-4821'), plan: 'pro' },
  });
});

test('waitFor reads a unique value', async ({ app, agent }) => {
  await app.open();
  await agent.waitFor('the table shows company {name}', { params: { name: unique('acme-7310') }, interval: 100 });
});

test('assert sees a secret by name only', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the password field holds {password}', {
    params: { password: credentials.user('member').password },
  });
});

test('assert redacts a registered value passed as a plain string', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the note reads {note}', { params: { note: ${JSON.stringify(QUOTED_SECRET)} } });
});

test('assert refuses params that are not a plain object', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the Home heading is visible', { params: 'acme' });
});

test('waitFor refuses params with a cycle', async ({ app, agent }) => {
  await app.open();
  const looped = { name: 'acme' };
  looped.self = looped;
  await agent.waitFor('the Home heading is visible', { params: looped });
});
`;

describe('judgment params on the built-in judge', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const judge = installFakeModel(() => judgment(true, 'the observation supports it'), { modelId: 'judge' });
    const result = await runProject(
      { 'tests/params.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model: judge, judge } },
          credentials: {
            member: { username: 'ada', password: SECRET_VALUE },
            quoted: { username: 'bo', password: QUOTED_SECRET },
          },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const instructionFor = (prefix: string): string =>
    fakeCalls.find((call) => call.instruction.startsWith(prefix))!.instruction;

  it('hands assert the unique value and plain params next to the {name} instruction', () => {
    expect(resultByTitle(outcome, 'assert reads a unique value').status).toBe('passed');
    expect(instructionFor('the table shows company {name} on')).toBe(
      'the table shows company {name} on the {plan} plan\nParameters: {"name":"acme-4821","plan":"pro"}',
    );
  });

  it('hands waitFor the unique value', () => {
    expect(resultByTitle(outcome, 'waitFor reads a unique value').status).toBe('passed');
    expect(instructionFor('the table shows company {name}\n')).toBe(
      'the table shows company {name}\nParameters: {"name":"acme-7310"}',
    );
  });

  it('shows the judge a secret param as its name, never its value', () => {
    expect(resultByTitle(outcome, 'assert sees a secret by name only').status).toBe('passed');
    const instruction = instructionFor('the password field holds');
    expect(instruction).toContain('"password":{"kind":"secret","name":"member.password"');
    expect(fakeCalls.some((call) => `${call.system}\n${call.prompt}`.includes(SECRET_VALUE))).toBe(false);
  });

  it('redacts a registered value a plain param spells out, quotes included', () => {
    expect(resultByTitle(outcome, 'assert redacts a registered value passed as a plain string').status).toBe('passed');
    expect(instructionFor('the note reads')).toMatch(/Parameters: \{"note":"<secret:[^>]+>"\}/);
    const escaped = JSON.stringify(QUOTED_SECRET).slice(1, -1);
    const sent = fakeCalls.map((call) => `${call.system}\n${call.prompt}`);
    expect(sent.some((text) => text.includes(QUOTED_SECRET) || text.includes(escaped))).toBe(false);
  });

  it('rejects invalid params naming the method that took them', () => {
    const assertError = resultByTitle(outcome, 'assert refuses params that are not a plain object').attempts.at(-1)!.error!;
    expect(assertError.code).toBe('INVALID_ARGUMENT');
    expect(assertError.message).toContain('agent.assert params must be a plain object');
    const waitForError = resultByTitle(outcome, 'waitFor refuses params with a cycle').attempts.at(-1)!.error!;
    expect(waitForError.code).toBe('INVALID_ARGUMENT');
    expect(waitForError.message).toContain('agent.waitFor params contains a cycle');
  });
});

const EXECUTOR_SUITE = `import { test, credentials, unique } from 'e2e';

test('assert params reach a custom executor', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the table shows company {name}', {
    params: { name: unique('acme-9902'), password: credentials.user('member').password },
  });
});
`;

describe('judgment params through a custom executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const steps: StepExecutorContext['step'][] = [];
  const fillErrors: unknown[] = [];

  const probing: StepExecutor = {
    name: 'params-probe',
    version: '1',
    async runStep(context: StepExecutorContext) {
      steps.push(context.step);
      await context.actions.typeSecret({ id: 'n1' }, 'member.password').catch((error: unknown) => fillErrors.push(error));
      return { status: 'passed', summary: 'checked' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/executor.e2e.ts': EXECUTOR_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { executor: probing } },
          credentials: { member: { username: 'ada', password: SECRET_VALUE } },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands the assert step the projected params, the secret by name only', () => {
    expect(resultByTitle(outcome, 'assert params reach a custom executor').status).toBe('passed');
    const step = steps.find((candidate) => candidate.kind === 'assert')!;
    expect(step.params).toEqual({
      name: 'acme-9902',
      password: { kind: 'secret', name: 'member.password', purpose: expect.any(String) },
    });
    expect(JSON.stringify(step)).not.toContain(SECRET_VALUE);
  });

  it('never lets an assert step fill a secret it names', () => {
    expect(fillErrors).toEqual([expect.objectContaining({ code: 'POLICY_DENIED' })]);
  });
});
