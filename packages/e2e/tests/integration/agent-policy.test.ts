/**
 * Agent policy, credential, and error-classification coverage. The scripted
 * model deliberately misbehaves so runner-owned authorization and error
 * assignment are observable (spec 02-test-api.md, 14-security.md).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { bestMatch, installFakeModel, judgment, locateBestMatch } from '../helpers/fake-model.ts';
import type { FakeCall } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect, credentials } from 'e2e';

test('fills a secret into a password field', async ({ app, agent, screen }) => {
  await app.open();
  await agent.type('the Password field', credentials.user('member').password);
  await agent.assert('the password field has a value');
});

test('denies a password secret sent to a username field', async ({ app, agent }) => {
  await app.open();
  await agent.type('the Email field', credentials.user('member').password);
});

test('denies a credential that is not configured', async ({ app, agent }) => {
  await app.open();
  await agent.type('the Password field', credentials.user('ghost').password);
});

test('rejects a node reference absent from the observation', async ({ app, agent }) => {
  await app.open();
  await agent.tap('a node that does not exist');
});

test('repairs a stale observation revision', async ({ app, agent, screen }) => {
  await app.open();
  await agent.tap('the stale increment button');
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('rejects a response outside the closed grammar', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the malformed increment button');
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

const NO_MODEL_SUITE = `import { test } from 'e2e';

test('requires model configuration', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});
`;

/** Scripted responder whose behavior is selected by the instruction. */
function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-1') return judgment(true, 'the field has a value');
  if (call.schemaName === 'agent-extract-1') {
    const status = call.lines.find((line) => line.includes('status'));
    const counter = /text="([^"]*)"/.exec(status ?? '')?.[1] ?? '';
    // First attempt returns a bare value; the repair round wraps it.
    // The first attempt returns a bare value; the repair round wraps it.
    return call.prompt.includes('<previous-attempt-rejected>') ? { counter } : counter;
  }
  switch (call.instruction) {
    case 'a node that does not exist':
      return {
        protocolVersion: 'agent-locate-1',
        target: { id: 'n99999', revision: call.revision },
        explanation: 'invented node',
      };
    case 'the stale increment button':
      // First response cites a stale revision; the repair round corrects it,
      // simulating a model that self-corrects a hallucinated reference.
      if (call.prompt.includes('<previous-attempt-rejected>')) return locateBestMatch(call);
      return {
        protocolVersion: 'agent-locate-1',
        target: { id: bestMatch(call).id, revision: 'r0' },
        explanation: 'stale revision',
      };
    case 'the malformed increment button':
      return {
        protocolVersion: 'agent-locate-1',
        target: { id: bestMatch(call).id, revision: call.revision },
        action: 'tap',
      };
    default:
      return locateBestMatch(call);
  }
}

describe('agent policy and error classification', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let unconfigured: RunOutcome;
  let unconfiguredProject: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const main = await runProject(
      { 'tests/policy.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
          agent: { model },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    outcome = main.outcome;
    project = main.project;

    const missing = await runProject(
      { 'tests/no-model.e2e.ts': NO_MODEL_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] } },
    );
    unconfigured = missing.outcome;
    unconfiguredProject = missing.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
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

  it('denies a password secret aimed at a username field', () => {
    const result = resultByTitle(outcome, 'denies a password secret sent to a username field');
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.category).toBe('configuration');
    expect(error.message).toContain('purpose');
  });

  it('reports an unconfigured credential as a configuration failure', () => {
    const result = resultByTitle(outcome, 'denies a credential that is not configured');
    expect(result.status).toBe('failed');
    expect(result.attempts.at(-1)!.error!.code).toBe('AUTH_CREDENTIAL_UNAVAILABLE');
    expect(result.attempts.at(-1)!.error!.category).toBe('configuration');
  });

  it('rejects a node reference that is not in the current observation', () => {
    const result = resultByTitle(outcome, 'rejects a node reference absent from the observation');
    const error = result.attempts.at(-1)!.error!;
    // One repair round is allowed; a model that keeps inventing ids exhausts
    // the budget as invalid output, never as a guessed action.
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.category).toBe('test');
    expect(error.message).toContain('not in the current observation');
    const step = result.attempts.at(-1)!.steps.at(-1)!;
    expect(step.metrics!.modelCalls).toBe(2);
    expect(
      step.events.some((event) => event.kind === 'schema' && event.status === 'failed'),
    ).toBe(true);
  });

  it('repairs a stale observation revision with one extra model call', () => {
    const result = resultByTitle(outcome, 'repairs a stale observation revision');
    expect(result.status).toBe('passed');
    const step = result.attempts
      .at(-1)!
      .steps.find((candidate) => candidate.api === 'agent.tap')!;
    expect(step.metrics!.modelCalls).toBe(2);
  });

  it('rejects a response with fields outside the closed grammar', () => {
    const result = resultByTitle(outcome, 'rejects a response outside the closed grammar');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.category).toBe('test');
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

  const SERIAL_SUITE = `import { test } from 'e2e';

test.describe('group', { serial: true }, () => {
  test('captures evidence from a shared session', async ({ app, agent }) => {
    await app.open();
    await agent.assert('the Home heading is visible');
  });
});
`;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel((call) =>
      call.schemaName === 'agent-judgment-1'
        ? judgment(true, 'the heading is present')
        : locateBestMatch(call),
    );
    const result = await runProject(
      { 'tests/serial.e2e.ts': SERIAL_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'],
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
