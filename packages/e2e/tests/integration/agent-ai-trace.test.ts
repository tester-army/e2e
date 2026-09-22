/**
 * `e2e run --ai-trace`: every model round trip of a run lands in
 * `.e2e/ai-trace.json` in the AI SDK devtools database shape, attributed to
 * the test and step that made it, on both transports — in-process and
 * child-process workers.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, nodeIdFor } from '../helpers/fake-loop-model.ts';
import {
  resultByTitle,
  runProject,
  runProjectWithConfigFile,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import type { AiTraceDocument } from '../../src/internal/ai-trace.ts';

const SUITE = `import { test, expect } from 'e2e';

test('default agent increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once and verify it shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

function readTrace(project: FixtureProject): AiTraceDocument {
  const file = path.join(project.dir, '.e2e', 'ai-trace.json');
  expect(existsSync(file)).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as AiTraceDocument;
}

/** The checks a viewer's devtools adapter runs before accepting a database. */
function expectDevtoolsShape(document: AiTraceDocument): void {
  expect(Array.isArray(document.runs)).toBe(true);
  expect(Array.isArray(document.steps)).toBe(true);
  for (const run of document.runs) expect(typeof run.id).toBe('string');
  for (const step of document.steps) {
    expect(typeof step.run_id).toBe('string');
    expect(typeof step.input).toBe('string');
  }
}

describe('--ai-trace on the in-process transport', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) {
        return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }];
      }
      return [
        {
          toolName: 'complete_step',
          input: { status: 'passed', summary: 'tapped once; the counter shows 1' },
        },
      ];
    });
    const result = await runProject(
      { 'tests/loop.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } },
        runOptions: { aiTrace: true },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes and reports where the trace was written', () => {
    expect(resultByTitle(outcome, 'default agent increments the counter').status).toBe('passed');
    expect(outcome.aiTracePath).toBe(path.join(project.dir, '.e2e', 'ai-trace.json'));
  });

  it('records one run for the act step with one step per model turn', () => {
    const document = readTrace(project);
    expectDevtoolsShape(document);
    expect(document.runs).toHaveLength(1);
    const run = document.runs[0]!;
    expect(run.function_id).toBe(
      'default agent increments the counter · agent.act "increment the counter once and verify it shows 1"',
    );
    expect(run.e2e).toMatchObject({
      test: 'default agent increments the counter',
      target: 'web',
      attempt: 0,
      api: 'agent.act',
    });
    const steps = document.steps.filter((step) => step.run_id === run.id);
    expect(steps.map((step) => step.step_number)).toEqual([1, 2]);
    expect(steps.every((step) => step.model_id === 'scripted-loop')).toBe(true);
    expect(steps.every((step) => step.provider === 'fake-loop')).toBe(true);
  });

  it('records the prompt the model saw, its tool definitions with schemas, and its answer', () => {
    const document = readTrace(project);
    const [first, second] = document.steps;
    const input = JSON.parse(first!.input) as {
      prompt: { role: string; content: unknown }[];
      tools: { name: string; description?: string; parameters?: { type?: string } }[];
    };
    expect(input.prompt[0]!.role).toBe('system');
    expect(String(input.prompt[0]!.content)).toContain('autonomous end-to-end testing agent');
    const user = input.prompt.find((message) => message.role === 'user')!.content;
    // A pixel-mode opening prompt is content parts: the text part carries the instruction.
    const userText = Array.isArray(user)
      ? (user as { type: string; text?: string }[]).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : String(user);
    expect(userText).toContain('increment the counter once');
    const names = input.tools.map((tool) => tool.name);
    expect(names).toContain('tap');
    expect(names).toContain('complete_step');
    for (const tool of input.tools) expect(tool.parameters?.type).toBe('object');

    const output = JSON.parse(first!.output!) as {
      finishReason: string;
      response: { messages: { role: string }[] };
    };
    expect(output.finishReason).toBe('tool-calls');
    expect(output.response.messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(JSON.parse(first!.usage!)).toMatchObject({ inputTokens: 100, outputTokens: 20 });

    // The second turn's prompt carries the first turn's tool result.
    const later = JSON.parse(second!.input) as { prompt: { role: string }[] };
    expect(later.prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});

describe('--ai-trace on child-process workers', () => {
  const SECRET = 'worker-secret-Qk4x7731';
  const SERIAL_SUITE = `import { test } from 'e2e';

test.describe('serial', { serial: true }, () => {
  test('first member', async ({ app, agent }) => {
    await app.open();
    await agent.act('use key ${SECRET} to continue');
  });
  test('second member', async ({ agent }) => {
    await agent.act('say what the previous step did');
  });
});
`;
  /** Taps Increment on a counter step's first turn; every other turn concludes, echoing the password. */
  const ECHO_RESPONDER_SOURCE = `(call) => {
  if (call.toolResults.length === 0 && /increment the counter/.test(call.lastPrompt)) {
    const line = call.prompt.split('\\n').find((candidate) => /button "Increment"/.test(candidate)) ?? '';
    const match = /#(\\S+)/.exec(line);
    return [{ toolName: 'tap', input: { target: match ? match[1] : 'n1' } }];
  }
  return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done, the password was ' + ${JSON.stringify(SECRET)} } }];
}`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // A worker re-loads the config module itself, so the scripted model is
    // built inside the config file from the shared helper.
    const helper = fileURLToPath(new URL('../helpers/fake-loop-model.ts', import.meta.url));
    const configSource = `import type { E2EConfig } from 'e2e';
import { web } from '@e2edev/web';
import { installFakeLoopModel } from ${JSON.stringify(helper)};

export default {
  targets: [{ name: 'web', platform: 'web', engine: web({ url: process.env.APP_URL! }) }],
  workers: 2,
  agents: { default: { model: installFakeLoopModel(${ECHO_RESPONDER_SOURCE}) } },
  credentials: { member: { username: 'ada', password: ${JSON.stringify(SECRET)} } },
} satisfies E2EConfig;
`;
    const result = await runProjectWithConfigFile(
      {
        'tests/one.e2e.ts': SUITE,
        'tests/two.e2e.ts': SUITE.replace('increments', 'increments again'),
        'tests/serial.e2e.ts': SERIAL_SUITE,
      },
      { appUrl: app.url, configSource, runOptions: { aiTrace: true } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('collects every worker’s model calls into one trace file', () => {
    const failures = outcome.results.flatMap((result) => result.attempts).flatMap((attempt) => attempt.error ?? []);
    expect(outcome.exitCode, JSON.stringify({ runErrors: outcome.report.run.errors, failures }, null, 2)).toBe(0);
    const document = readTrace(project);
    expectDevtoolsShape(document);
    const names = document.runs.map((run) => run.function_id).toSorted();
    expect(names).toEqual([
      'default agent increments again the counter · agent.act "increment the counter once and verify it shows 1"',
      'default agent increments the counter · agent.act "increment the counter once and verify it shows 1"',
      'serial › first member · agent.act "use key <secret:member> to continue"',
      'serial › second member · agent.act "say what the previous step did"',
    ]);
    for (const run of document.runs) {
      const turns = document.steps.filter((step) => step.run_id === run.id).length;
      expect(turns, run.function_id ?? '').toBe(run.e2e?.label?.startsWith('increment') === true ? 2 : 1);
    }
    // File order is time order, whichever worker finished first.
    const starts = document.steps.map((step) => step.started_at);
    expect(starts).toEqual(starts.toSorted());
  });

  it('ships every record through the worker’s ledger: the trace, the report, the serial group, and the outcome carry the name', () => {
    const traceText = readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8');
    expect(traceText).not.toContain(SECRET);
    expect(traceText).toContain('done, the password was <secret:member>');
    const reportText = readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8');
    expect(reportText).not.toContain(SECRET);
    expect(JSON.stringify(outcome.results.map(({ target: _target, ...record }) => record))).not.toContain(SECRET);
    const group = outcome.report.run.serialGroups[0]!;
    expect(group.status).toBe('passed');
    const labels = group.attempts[0]!.members.map((member) =>
      member.steps.filter((step) => step.api === 'agent.act').map((step) => step.label),
    );
    expect(labels).toEqual([['use key <secret:member> to continue'], ['say what the previous step did']]);
    const explanations = group.attempts[0]!.members.flatMap((member) => member.steps.map((step) => step.explanation));
    expect(explanations).toContain('done, the password was <secret:member>');
  });
});

describe('--ai-trace and the secret ledger', () => {
  // A quote and an ampersand: the JSON-string form differs from the raw one.
  const SECRET = 'trace-secret-Zq9"&2718';
  const TITLE = 'the model echoes a secret';
  const ECHO_SUITE = `import { test } from 'e2e';

test('${TITLE}', async ({ app, agent }) => {
  await app.open();
  await agent.act('finish the step');
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(() => [
      { toolName: 'complete_step', input: { status: 'passed', summary: `done, the password was ${SECRET}` } },
    ]);
    const result = await runProject(
      { 'tests/echo.e2e.ts': ECHO_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
          credentials: { member: { username: 'ada', password: SECRET } },
        },
        runOptions: { aiTrace: true },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('replaces a secret the model echoed in a tool call with its name', () => {
    expect(resultByTitle(outcome, TITLE).status).toBe('passed');
    const text = readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8');
    // The JSON text escapes the quote, so the raw value is checked by its prefix too.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('trace-secret-Zq9');
    const document = JSON.parse(text) as AiTraceDocument;
    expectDevtoolsShape(document);
    const answered = document.steps.filter((step) => step.output !== null);
    expect(answered.length).toBeGreaterThan(0);
    for (const step of answered) {
      expect(JSON.stringify(JSON.parse(step.output!))).toContain('done, the password was <secret:member>');
    }
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', () => {
    expect(statSync(path.join(project.dir, '.e2e', 'ai-trace.json')).mode & 0o777).toBe(0o600);
  });
});

describe('--ai-trace with the ledger as it stands when the files are written', () => {
  const SECRET = 'trace-title-secret-8841';
  const LATE = 'late-provider-secret-5512';
  const TITLED = `the title spells ${SECRET}`;
  const LATE_TITLE = 'a provider resolves after the first step';
  const LATE_SUITE = `import { test, secrets } from 'e2e';

test('${TITLED}', async ({ app, agent }) => {
  await app.open();
  await agent.act('finish the step');
});

test('${LATE_TITLE}', async ({ app, agent, screen }) => {
  await app.open('/?token=${LATE}');
  await agent.act('finish the step');
  await screen.getByLabel('Password').fill(secrets.get('late'));
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let traceText: string;
  let reportText: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(() => [
      { toolName: 'complete_step', input: { status: 'passed', summary: 'done' } },
    ]);
    const result = await runProject(
      { 'tests/late.e2e.ts': LATE_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
          // A brace as a password: a secret that is JSON punctuation.
          credentials: {
            member: { username: 'ada', password: SECRET },
            brace: { username: 'bob', password: '{' },
          },
          secrets: { late: async () => LATE },
        },
        runOptions: { aiTrace: true },
      },
    );
    outcome = result.outcome;
    project = result.project;
    traceText = readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8');
    reportText = readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8');
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes both tests', () => {
    const failures = outcome.results.flatMap((result) => result.attempts).flatMap((attempt) => attempt.error ?? []);
    expect(outcome.exitCode, JSON.stringify({ runErrors: outcome.report.run.errors, failures }, null, 2)).toBe(0);
  });

  it('keeps a secret in a test title out of the run records and the report', () => {
    expect(traceText).not.toContain(SECRET);
    expect(reportText).not.toContain(SECRET);
    const document = JSON.parse(traceText) as AiTraceDocument;
    const run = document.runs.find((candidate) => candidate.e2e?.test === 'the title spells <secret:member>');
    expect(run?.function_id).toBe('the title spells <secret:member> · agent.act "finish the step"');
    expect(outcome.report.run.results.map((result) => result.titlePath.join(' › '))).toContain(
      'the title spells <secret:member>',
    );
  });

  it('keeps every column parseable with a secret that is JSON punctuation', () => {
    const document = JSON.parse(traceText) as AiTraceDocument;
    expectDevtoolsShape(document);
    expect(document.steps.length).toBeGreaterThan(0);
    for (const { input, output } of document.steps) {
      expect(() => JSON.parse(input)).not.toThrow();
      if (output !== null) expect(() => JSON.parse(output)).not.toThrow();
    }
  });

  it('covers a value a provider resolved after the label was recorded and the trace step had closed', () => {
    expect(traceText).not.toContain(LATE);
    expect(reportText).not.toContain(LATE);
    const late = outcome.report.run.results.find((result) => result.titlePath.join(' › ') === LATE_TITLE)!;
    const open = late.attempts[0]!.steps.find((step) => step.api === 'app.open')!;
    expect(open.label).toBe('/?token=<secret:late>');
    // The location the model saw in the first step's prompt carried the value; the file has the name.
    expect(traceText).toContain('<secret:late>');
  });

  it('hands the outcome its records as the report has them, the live target kept', () => {
    expect(JSON.stringify(outcome.results.map(({ target: _target, ...record }) => record))).not.toContain(LATE);
    const late = outcome.results.find((result) => result.test.title === LATE_TITLE)!;
    expect(late.attempts[0]!.steps.find((step) => step.api === 'app.open')!.label).toBe('/?token=<secret:late>');
    expect(late.target.name).toBe('web');
    expect(late.target.engine?.name).toBeTypeOf('string');
  });
});

describe('--ai-trace and what the model said beside its tool calls', () => {
  const SECRET = 'column-secret-Vt5x9902';
  const TALKS = 'the model remarks and the provider annotates';
  const REJECTED = 'the provider rejects the call';
  const COLUMN_SUITE = `import { test } from 'e2e';

test('${TALKS}', async ({ app, agent }) => {
  await app.open();
  await agent.act('finish the step with a remark');
});

test('${REJECTED}', async ({ app, agent }) => {
  await app.open();
  await agent.act('finish the step after a rejection');
});
`;
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let traceText: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel((call) => {
      if (call.lastPrompt.includes('after a rejection')) throw new Error(`rejected: the key ${SECRET} is not valid`);
      return {
        text: `noting that the password is ${SECRET}`,
        toolCalls: [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }],
        providerMetadata: { fake: { echo: SECRET } },
      };
    });
    const result = await runProject(
      { 'tests/columns.e2e.ts': COLUMN_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
          credentials: { member: { username: 'ada', password: SECRET } },
        },
        runOptions: { aiTrace: true },
      },
    );
    outcome = result.outcome;
    project = result.project;
    traceText = readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8');
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('keeps the value out of the file and the report', () => {
    expect(resultByTitle(outcome, TALKS).status).toBe('passed');
    expect(resultByTitle(outcome, REJECTED).status).toBe('failed');
    expect(traceText).not.toContain(SECRET);
    expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
  });

  it('redacts the assistant text and the provider metadata of a turn', () => {
    const document = JSON.parse(traceText) as AiTraceDocument;
    const run = document.runs.find((candidate) => candidate.e2e?.test === TALKS)!;
    const turn = document.steps.find((step) => step.run_id === run.id);
    const output = JSON.parse(turn!.output!) as {
      content: { type: string; text?: string }[];
      providerMetadata?: unknown;
      response: { messages: unknown[] };
    };
    expect(output.content.find((part) => part.type === 'text')?.text).toBe('noting that the password is <secret:member>');
    expect(output.providerMetadata).toEqual({ fake: { echo: '<secret:member>' } });
    expect(JSON.stringify(output.response.messages)).toContain('noting that the password is <secret:member>');
  });

  it('redacts the error of a turn the provider rejected', () => {
    const document = JSON.parse(traceText) as AiTraceDocument;
    const run = document.runs.find((candidate) => candidate.e2e?.test === REJECTED)!;
    const failed = document.steps.filter((step) => step.run_id === run.id && step.error !== null);
    expect(failed.length).toBeGreaterThan(0);
    for (const step of failed) expect(step.error).toContain('rejected: the key <secret:member> is not valid');
    const attempt = resultByTitle(outcome, REJECTED).attempts.at(-1)!;
    expect(attempt.error?.message).toContain('<secret:member>');
  });
});
