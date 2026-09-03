/**
 * Agent policy, credential, and error-classification coverage on the judgment
 * tier (spec 02-test-api.md, 14-security.md). Secret-fill authorization for
 * planned flows is covered by agent-act-stress.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import type { FakeCall } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials } from '@e2edev/e2e';

test('fills a secret into a password field', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('the password field has a value');
});

test('repairs an extraction that fails the caller schema', async ({ app, agent }) => {
  await app.open();
  const data = await agent.extract('the counter value', {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          typeof value?.counter === 'string'
            ? { value }
            : { issues: [{ path: ['counter'], message: 'Required' }] },
      },
    },
  });
  if (data.counter !== '0') throw new Error('unexpected counter ' + data.counter);
});
`;

const UNCONFIGURED_SUITE = `import { test, credentials } from '@e2edev/e2e';

test('denies a credential that is not configured', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('ghost').password);
});
`;

const NO_MODEL_SUITE = `import { test } from '@e2edev/e2e';

test('requires model configuration', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});
`;

/** Scripted responder whose behavior is selected by the schema. */
function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-1') return judgment(true, 'the field has a value');
  if (call.schemaName === 'agent-extract-1') {
    const status = call.lines.find((line) => line.includes('status'));
    const counter = /text="([^"]*)"/.exec(status ?? '')?.[1] ?? '';
    // The first attempt returns a bare value; the repair round wraps it.
    return call.prompt.includes('<previous-attempt-rejected>') ? { counter } : counter;
  }
  throw new Error(`unexpected schema ${call.schemaName}`);
}

describe('agent policy and error classification', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let unconfigured: RunOutcome;
  let unconfiguredProject: FixtureProject;
  let ghost: RunOutcome;
  let ghostProject: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const main = await runProject(
      { 'tests/policy.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: { model },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    outcome = main.outcome;
    project = main.project;

    const missingCredential = await runProject(
      { 'tests/ghost.e2e.ts': UNCONFIGURED_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    ghost = missingCredential.outcome;
    ghostProject = missingCredential.project;

    const missing = await runProject(
      { 'tests/no-model.e2e.ts': NO_MODEL_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts' } },
    );
    unconfigured = missing.outcome;
    unconfiguredProject = missing.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    ghostProject?.cleanup();
    unconfiguredProject?.cleanup();
    await app?.close();
  });

  it('fills a secret into a purpose-compatible secure field', () => {
    expect(resultByTitle(outcome, 'fills a secret into a password field').status).toBe('passed');
  });

  it('suppresses screenshot evidence once the viewport is pixel-tainted', () => {
    const attempt = resultByTitle(outcome, 'fills a secret into a password field').attempts.at(-1)!;
    const assertion = attempt.steps.find((step) => step.api === 'agent.assert')!;
    expect(assertion.artifacts).toEqual([]);
    expect(
      assertion.events.some(
        (event) => event.kind === 'policy' && event.name === 'assert.screenshot' && event.decision === 'denied',
      ),
    ).toBe(true);
  });

  it('never sends a secret value to the model', () => {
    const result = resultByTitle(outcome, 'fills a secret into a password field');
    expect(JSON.stringify(result.attempts)).not.toContain('hunter2-secret');
  });

  it('reports an unconfigured credential as a configuration failure', () => {
    const result = resultByTitle(ghost, 'denies a credential that is not configured');
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error!.code).toBe('AUTH_CREDENTIAL_UNAVAILABLE');
    expect(result.attempts.at(-1)!.error!.category).toBe('configuration');
  });

  it('spends one repair call to satisfy the caller schema', () => {
    const result = resultByTitle(outcome, 'repairs an extraction that fails the caller schema');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.extract')!;
    expect(step.metrics!.modelCalls).toBe(2);
  });

  it('fails the first model call with MODEL_UNAVAILABLE when no model is configured', () => {
    const result = resultByTitle(unconfigured, 'requires model configuration');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.category).toBe('configuration');
    expect(unconfigured.exitCode).toBe(2);
  });
});

describe('serial group artifacts', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  const SERIAL_SUITE = `import { test } from '@e2edev/e2e';

test.describe('group', { serial: true }, () => {
  test('captures evidence from a shared session', async ({ app, agent }) => {
    await app.open();
    await agent.assert('the Home heading is visible');
  });
});
`;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(() => judgment(true, 'the heading is present'));
    const result = await runProject(
      { 'tests/serial.e2e.ts': SERIAL_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: { model },
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

  it('records a resolvable path, size, and digest for member artifacts', () => {
    // A shared session writes into the group directory, so a member that
    // registers against its own directory produces an unresolvable artifact.
    assertValidReport(outcome.report);
    const group = outcome.report.run.serialGroups[0]!;
    const screenshot = group.attempts
      .at(-1)!
      .artifacts.find((artifact) => artifact.kind === 'screenshot')!;
    expect(screenshot.path).toBeDefined();
    expect(screenshot.size).toBeGreaterThan(0);
    expect(screenshot.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
