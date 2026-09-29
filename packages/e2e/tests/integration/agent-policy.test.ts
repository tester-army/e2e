/**
 * Agent policy, credential, and error-classification coverage on the judgment
 * tier. Secret-fill authorization for planned flows is covered by
 * agent-act-stress.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import type { FakeCall } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
import type { SdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP_URL } from '../helpers/fake-engine.ts';

const SUITE = `import { test, credentials } from 'e2e';

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

const UNCONFIGURED_SUITE = `import { test, credentials } from 'e2e';

test('denies a credential that is not configured', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('ghost').password);
});
`;

const NO_MODEL_SUITE = `import { test } from 'e2e';

test('requires model configuration', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});

test('would also need the model', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});

test('would need it as well', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});
`;

const CANONICAL_SUITE = `import { test } from 'e2e';

test('judges with the model a custom executor brought', async ({ app, agent }) => {
  await app.open();
  const data = await agent.extract('the counter value', {
    schema: { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } },
  });
  if (data.counter !== '0') throw new Error('unexpected counter ' + data.counter);
});
`;

const VOCABULARY_SUITE = `import { test, expect } from 'e2e';

test('the agent increments the counter once', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

/** Scripted responder whose behavior is selected by the schema. */
function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-2') return judgment(true, 'the field has a value');
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
  let canonical: RunOutcome;
  let canonicalProject: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond);
    const main = await runProject(
      { 'tests/policy.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
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

    const oneModel = await runProject(
      { 'tests/canonical.e2e.ts': CANONICAL_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: {
            default: {
              executor: {
                name: 'house-brain',
                runStep: async () => ({ status: 'passed', summary: 'unused' }),
                model: installFakeModel(() => ({ counter: '0' })) as unknown as SdkLanguageModel,
              },
            },
          },
        },
      },
    );
    canonical = oneModel.outcome;
    canonicalProject = oneModel.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    ghostProject?.cleanup();
    unconfiguredProject?.cleanup();
    canonicalProject?.cleanup();
    await app?.close();
  });

  it('judges with the model a custom executor brought, with no entry model', () => {
    expect(canonical.exitCode).toBe(0);
    const result = resultByTitle(canonical, 'judges with the model a custom executor brought');
    expect(result.status).toBe('passed');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.extract')!;
    expect(step.model).toMatchObject({ provider: 'fake', model: 'scripted' });
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

  it('reports a missing model once for the run and stops, instead of once per test', () => {
    const errors = unconfigured.report.run.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'MODEL_UNAVAILABLE', category: 'configuration' });
    expect(unconfigured.exitCode).toBe(2);
    expect(unconfigured.status).toBe('error');
    expect(unconfigured.results).toHaveLength(3);
    const first = resultByTitle(unconfigured, 'requires model configuration');
    expect(['MODEL_UNAVAILABLE', 'INTERRUPTED']).toContain(first.attempts.at(-1)!.error!.code);
    for (const title of ['would also need the model', 'would need it as well']) {
      const result = resultByTitle(unconfigured, title);
      expect(result.status).toBe('skipped');
      expect(result.attempts).toHaveLength(0);
    }
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
    const model = installFakeModel(() => judgment(true, 'the heading is present'));
    const result = await runProject(
      { 'tests/serial.e2e.ts': SERIAL_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
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

describe('tool calls outside the vocabulary', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const agentStep = (outcome: RunOutcome) =>
    resultByTitle(outcome, 'the agent increments the counter once').attempts.at(-1)!.steps.find((step) => step.api === 'agent.act')!;

  it('refuses a call with a field the schema does not declare, names the field, and runs nothing until the repaired call', async () => {
    const model = installFakeLoopModel((call) => {
      const target = nodeIdFor(call.prompt, /button "Increment"/);
      if (call.turn === 1) return [{ toolName: 'tap', input: { target, force: true, selector: '#increment' } }];
      if (call.turn === 2) return [{ toolName: 'tap', input: { target } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 1' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/vocabulary.e2e.ts': VOCABULARY_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'the agent increments the counter once');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      // The refusal is the call's result: it names the tool and the keys, and it is not a policy denial.
      const refusal = loopCalls[1]!.lastToolResult;
      expect(refusal).toContain('Invalid input for tool tap');
      expect(refusal).toContain('unrecognized_keys');
      expect(refusal).toContain('"force"');
      expect(refusal).toContain('"selector"');
      expect(refusal).not.toContain('POLICY_DENIED');
      // Only the repaired call reached the app: one action, and its result shows the change.
      expect(loopCalls).toHaveLength(3);
      expect(loopCalls[2]!.lastToolResult).toMatch(/changed #\S+ status "Counter" text="1"/);
      const step = agentStep(outcome);
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(3);
      // The step's turns show the refusal as the model read it.
      expect(step.turns![0]!.outcome).toContain(`[tap] error: ${refusal.split('\n')[0]}`);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('runs the valid call of a batched turn, refuses the decorated one, and records both in the turn', async () => {
    const model = installFakeLoopModel((call) => {
      const target = nodeIdFor(call.prompt, /button "Increment"/);
      if (call.turn === 1) {
        return [
          { toolName: 'tap', input: { target } },
          { toolName: 'tap', input: { target, force: true } },
        ];
      }
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 1' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/vocabulary.e2e.ts': VOCABULARY_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'the agent increments the counter once');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      // One turn, two results: the plain tap ran and reported the change; the decorated one never did.
      expect(loopCalls).toHaveLength(2);
      const results = loopCalls[1]!.toolResults;
      expect(results).toHaveLength(2);
      const ran = results.find((text) => text.startsWith('Tapped #'));
      const refused = results.find((text) => text.includes('Invalid input for tool tap'));
      expect(ran).toMatch(/changed #\S+ status "Counter" text="1"/);
      expect(refused).toContain('"force"');
      const step = agentStep(outcome);
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(2);
      const [turn] = step.turns!;
      expect(turn!.calls).toHaveLength(2);
      expect(turn!.outcome).toMatch(/\[tap\] Tapped #\S+\./);
      expect(turn!.outcome).toContain(`[tap] error: ${refused!.split('\n')[0]}`);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('drops the error code a passed verdict carries, notes it in the turn, and ends the step on that call with no repair turn', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 1', errorCode: 'ACTION_FAILED' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/vocabulary.e2e.ts': VOCABULARY_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'the agent increments the counter once');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      // One model sends a pass beside ACTION_FAILED about half the time; refusing it produced a 12 to 19 call loop. The code is dropped, never refused.
      expect(loopCalls).toHaveLength(2);
      const step = agentStep(outcome);
      expect(step.status).toBe('passed');
      expect(step.error).toBeUndefined();
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(2);
      const verdictTurn = step.turns!.at(-1)!;
      expect(verdictTurn.calls).toEqual(['complete_step({"status":"passed","summary":"the counter shows 1","errorCode":"ACTION_FAILED"})']);
      expect(verdictTurn.outcome).toBe('[complete_step] Step concluded as passed; the errorCode ACTION_FAILED you sent does not apply to a passed verdict and was ignored.');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('refuses a tool the step does not offer, lists the vocabulary, and runs nothing', async () => {
    const model = installFakeLoopModel((call) => {
      const target = nodeIdFor(call.prompt, /button "Increment"/);
      if (call.turn === 1) return [{ toolName: 'click', input: { target } }];
      if (call.turn === 2) return [{ toolName: 'tap', input: { target } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'the counter shows 1' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/vocabulary.e2e.ts': VOCABULARY_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'the agent increments the counter once');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      const refusal = loopCalls[1]!.lastToolResult;
      expect(refusal).toContain("Model tried to call unavailable tool 'click'");
      expect(refusal).toMatch(/Available tools: .*\btap\b/);
      expect(refusal).not.toContain('POLICY_DENIED');
      expect(loopCalls).toHaveLength(3);
      const step = agentStep(outcome);
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(3);
      expect(step.turns![0]!.outcome).toContain(`[click] error: ${refusal}`);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('counts refusals toward the failure streak, so a model that never gets a call past the schema is stopped', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1 && call.toolNames[0] === 'complete_step') {
        return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'could not get a call past the schema' } }];
      }
      // A different undeclared value every turn, so only the failure streak can stop this, never the repeat guard.
      return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/), attempt: call.turn } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/vocabulary.e2e.ts': VOCABULARY_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'the agent increments the counter once');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.message).toContain('could not get a call past the schema');
      const step = agentStep(outcome);
      expect(step.metrics!.actionSteps).toBe(0);
      // Three refusals warn, five force the verdict; a model this stuck never reaches the turn budget.
      expect(step.metrics!.modelCalls).toBeLessThanOrEqual(8);
      expect(loopCalls.some((call) => call.lastPrompt.includes('failed in a row'))).toBe(true);
      expect(loopCalls.at(-1)!.toolNames).toEqual(['complete_step']);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('a secret fill the engine rejects', () => {
  it('taints the pixels all the same, since the value may have reached the screen before the failure', async () => {
    const fake = createFakeEngine({
      tree: {
        ref: { id: 'root', revision: '' },
        role: 'document',
        children: [{ ref: { id: 'token', revision: '' }, role: 'textbox', name: 'Token' }],
      },
      perform: (_ref, action) => {
        if (action.kind === 'fill') throw new Error('the field detached after the value was typed');
      },
    });
    const tainted: boolean[] = [];
    const executor: StepExecutor = {
      name: 'rejected-fill',
      async runStep(context) {
        const observation = await context.observe();
        tainted.push(context.pixelsTainted);
        const failure = await context.actions
          .typeSecret({ id: nodeIdFor(observation.text, /textbox "Token"/) }, 'token')
          .then(() => undefined, (cause: unknown) => cause);
        tainted.push(context.pixelsTainted);
        return { status: 'failed', summary: String(failure) };
      },
    };
    const suite = `import { test, secrets } from 'e2e';

test('fills a token the engine rejects', async ({ agent }) => {
  await agent.act('fill the token', { params: { token: secrets.get('token') } });
});
`;
    const { outcome, project } = await runProject(
      { 'tests/rejected.e2e.ts': suite },
      {
        appUrl: FAKE_APP_URL,
        config: {
          targets: [{ name: 'fake', platform: 'fake', engine: fake.engine }],
          agents: { default: { executor } },
          secrets: { token: () => 'tok-7Qz-rejected' },
          cache: 'off',
        },
      },
    );
    try {
      expect(resultByTitle(outcome, 'fills a token the engine rejects').status).toBe('failed');
      expect(tainted).toEqual([false, true]);
    } finally {
      project.cleanup();
    }
  }, 60_000);
});
