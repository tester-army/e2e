/**
 * Agent policy, credential, and error-classification coverage on the judgment
 * tier, and the secret ledger's reach over what a test authored: step labels
 * and executor-attached screenshots. Secret-fill authorization for planned
 * flows is covered by agent-act-stress.test.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import type { FakeCall } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, resultByTitle, runExisting, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { createAgent } from '../../src/agent/default-agent.ts';
import type { SdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { defineEngine, LOCATOR_ACTION_KINDS } from '../../src/engine/index.ts';
import type { RunEvent } from '../../src/run/events.ts';

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

test('judges with the model createAgent brought', async ({ app, agent }) => {
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
            default: createAgent({
              model: installFakeModel(() => ({ counter: '0' })) as unknown as SdkLanguageModel,
            }),
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

  it('judges with the model createAgent brought, with no agent.model', () => {
    expect(canonical.exitCode).toBe(0);
    const result = resultByTitle(canonical, 'judges with the model createAgent brought');
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

describe('the secret ledger covers step labels', () => {
  const SECRET = 'hunter2-secret';
  const TITLE = 'spells the secret out in step labels';
  const LABEL_SUITE = `import { test } from 'e2e';

test('${TITLE}', async ({ app, agent }) => {
  await app.open('/?token=${SECRET}');
  await agent.act('use key ${SECRET} to continue');
  await agent.act('say what the previous step did');
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const stderr: string[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => [
      { toolName: 'complete_step', input: { status: 'passed', summary: `turn ${call.turn} done` } },
    ]);
    // The --debug step table goes straight to stderr; keep it for the assertions.
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    try {
      const result = await runProject(
        { 'tests/labels.e2e.ts': LABEL_SUITE },
        {
          appUrl: app.url,
          config: {
            tests: 'tests/**/*.e2e.ts',
            agents: { default: { model } },
            credentials: { member: { username: 'ada', password: SECRET } },
          },
          runOptions: { aiTrace: true, debug: true },
        },
      );
      outcome = result.outcome;
      project = result.project;
    } finally {
      write.mockRestore();
    }
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records every step label redacted', () => {
    const result = resultByTitle(outcome, TITLE);
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
    const steps = result.attempts.at(-1)!.steps;
    const labelsOf = (api: string) => steps.filter((step) => step.api === api).map((step) => step.label);
    expect(labelsOf('app.open')).toEqual(['/?token=<secret:member>']);
    expect(labelsOf('agent.act')).toEqual(['use key <secret:member> to continue', 'say what the previous step did']);
    expect(JSON.stringify(result.attempts)).not.toContain(SECRET);
  });

  it('hands the next step a redacted prior-step ledger', () => {
    const later = loopCalls.filter((call) => call.lastPrompt.includes('say what the previous step did'));
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) {
      const request = JSON.stringify(call);
      expect(request).toContain('use key <secret:member> to continue');
      expect(request).not.toContain(SECRET);
    }
  });

  it('hands a step its own instruction as written', () => {
    const own = loopCalls.filter(
      (call) => call.lastPrompt.includes('to continue') && !call.lastPrompt.includes('say what the previous step did'),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const call of own) expect(call.lastPrompt).toContain(`use key ${SECRET} to continue`);
  });

  it('names the AI trace run by the redacted label and keeps the plaintext out of the file', () => {
    const text = readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8');
    expect(text).not.toContain(SECRET);
    const document = JSON.parse(text) as { runs: { function_id: string | null }[] };
    expect(document.runs.map((run) => run.function_id)).toContain(
      `${TITLE} · agent.act "use key <secret:member> to continue"`,
    );
  });

  it('prints the --debug step table with the redacted label', () => {
    const output = stderr.join('');
    expect(output).toContain('[e2e debug] agent steps');
    expect(output).toContain('agent.act "use key <secret:member> to continue"');
    expect(output).not.toContain(SECRET);
  });
});

describe('attachScreenshot after a secret fill', () => {
  const SECRET = 'hunter2-secret';
  const TITLE = 'keeps evidence after filling the password';
  const FILL_SUITE = `import { test, credentials } from 'e2e';

test('${TITLE}', async ({ app, agent }) => {
  await app.open();
  await agent.act('fill the password', { params: { password: credentials.user('member').password } });
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const refusals: { tainted: boolean; code: string | undefined; message: string }[] = [];

  /** Fills the secret, then tries to keep pixels it captured before the fill as evidence. */
  const filler: StepExecutor = {
    name: 'fill-then-attach',
    async runStep(context) {
      const before = await context.observe({ tree: true, pixels: true });
      if (before.pixels === undefined) {
        return { status: 'failed', summary: `pixels withheld before the fill: ${before.pixelsWithheld ?? 'unknown'}` };
      }
      const secure = (function find(node): { id: string } | undefined {
        if (node.states?.secure === true) return node;
        for (const child of node.children ?? []) {
          const found = find(child);
          if (found !== undefined) return found;
        }
        return undefined;
      })(before.tree!);
      // Declared secrets are keyed by the credential's name, not the param's.
      await context.actions.typeSecret({ id: secure!.id }, 'member');
      try {
        await context.attachScreenshot(before.pixels, 'after-fill');
        return { status: 'failed', summary: 'attachScreenshot was allowed after a secret fill' };
      } catch (cause) {
        const error = cause as { code?: string; message: string };
        refusals.push({ tainted: context.pixelsTainted, code: error.code, message: error.message });
        return { status: 'passed', summary: 'attachScreenshot was denied' };
      }
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/attach.e2e.ts': FILL_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: filler },
          credentials: { member: { username: 'ada', password: SECRET } },
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

  it('refuses the attachment with POLICY_DENIED once the viewport is tainted', () => {
    const result = resultByTitle(outcome, TITLE);
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
    expect(refusals).toEqual([
      { tainted: true, code: 'POLICY_DENIED', message: expect.stringContaining('after a secret fill') },
    ]);
  });

  it('records the denial on the step and keeps no screenshot artifact', () => {
    const attempt = resultByTitle(outcome, TITLE).attempts.at(-1)!;
    const act = attempt.steps.find((step) => step.api === 'agent.act')!;
    expect(
      act.events.some(
        (event) => event.kind === 'policy' && event.name === 'attachScreenshot' && event.decision === 'denied',
      ),
    ).toBe(true);
    expect(attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toEqual([]);
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
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
      expect(verdictTurn.outcome).toBe('[complete_step] Step concluded; dropped errorCode ACTION_FAILED on a passed verdict.');
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

describe('the report passes the ledger as it is written', () => {
  const SECRET = 'evidence-secret-Hn8x4410';
  const TITLE = 'taps a button that is not there';
  const MISSING_SUITE = `import { test } from 'e2e';

test('${TITLE}', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Missing' }).tap();
});
`;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let reportText: string;
  const events: RunEvent[] = [];

  beforeAll(async () => {
    // Where a secret reaches the report outside any step record: the location
    // at failure, and a cleanup error serialized without a session to redact it.
    const engine = defineEngine({
      name: 'leaky',
      version: '1',
      spiVersion: 1,
      startAttempt: async () => {},
      observe: async () =>
        snapshot([{ ref: { id: 'note', revision: '' }, role: 'status', text: 'nothing to see' }], {
          location: `http://app.test/?token=${SECRET}`,
        }),
      locate: async () => [],
      actions: LOCATOR_ACTION_KINDS,
      perform: async () => {},
      dispose: async () => {
        throw new Error(`the engine leaked ${SECRET} while disposing`);
      },
    });
    project = createProject({ 'tests/missing.e2e.ts': MISSING_SUITE });
    outcome = await runExisting(project, {
      appUrl: 'http://127.0.0.1:4599',
      config: {
        targets: [{ name: 'leaky', platform: 'custom', engine }],
        tests: 'tests/**/*.e2e.ts',
        cache: 'off',
        actionTimeout: 300,
        credentials: { member: { username: 'ada', password: SECRET } },
      },
      runOptions: { onEvent: (event) => {
        events.push(event);
      } },
    });
    reportText = readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8');
  }, 60_000);

  afterAll(() => {
    project?.cleanup();
  });

  it('records the failure evidence with the value replaced', () => {
    const result = resultByTitle(outcome, TITLE);
    expect(result.status).toBe('failed');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(attempt.failure?.url).toBe('http://app.test/?token=<secret:member>');
    const reported = outcome.report.run.results.find((candidate) => candidate.titlePath.join(' › ') === TITLE)!;
    expect(reported.attempts.at(-1)!.failure?.url).toBe('http://app.test/?token=<secret:member>');
  });

  it('records a run error with the value replaced, in the report, on the outcome, and in the live event', () => {
    expect(outcome.report.run.errors.map((error) => [error.phase, error.message])).toContainEqual([
      'cleanup',
      'the engine leaked <secret:member> while disposing',
    ]);
    expect(reportText).not.toContain(SECRET);
    expect(JSON.stringify(outcome.results.map(({ target: _target, ...record }) => record))).not.toContain(SECRET);
    const streamed = events.flatMap((event) => (event.type === 'run-error' ? [event.error.message] : []));
    expect(streamed).toContain('the engine leaked <secret:member> while disposing');
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
