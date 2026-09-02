/**
 * `e2e run --ai-trace`: every model round trip of a run lands in
 * `.e2e/ai-trace.json` in the AI SDK devtools database shape, attributed to
 * the test and step that made it, on both transports — in-process and
 * child-process workers.
 */

import { existsSync, readFileSync } from 'node:fs';
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

/** Taps Increment on the first turn and concludes on the second. */
const RESPONDER_SOURCE = `(call) => {
  if (call.turn === 1) {
    const line = call.prompt.split('\\n').find((candidate) => /button "Increment"/.test(candidate)) ?? '';
    const match = /#(\\S+)/.exec(line);
    return [{ toolName: 'tap', input: { target: match ? match[1] : 'n1' } }];
  }
  return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'tapped once; the counter shows 1' } }];
}`;

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
        config: { tests: 'tests/**/*.e2e.ts', agent: { model } },
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
    expect(String(input.prompt.find((message) => message.role === 'user')!.content)).toContain(
      'increment the counter once',
    );
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
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // A worker re-loads the config module itself, so the scripted model is
    // built inside the config file from the shared helper.
    const helper = fileURLToPath(new URL('../helpers/fake-loop-model.ts', import.meta.url));
    const configSource = `import { defineConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';
import { installFakeLoopModel } from ${JSON.stringify(helper)};

export default defineConfig({
  app: { url: process.env.APP_URL! },
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  workers: 2,
  agent: { model: installFakeLoopModel(${RESPONDER_SOURCE}) },
});
`;
    const result = await runProjectWithConfigFile(
      { 'tests/one.e2e.ts': SUITE, 'tests/two.e2e.ts': SUITE.replace('increments', 'increments again') },
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
    expect(outcome.exitCode).toBe(0);
    const document = readTrace(project);
    expectDevtoolsShape(document);
    const names = document.runs.map((run) => run.function_id).toSorted();
    expect(names).toEqual([
      'default agent increments again the counter · agent.act "increment the counter once and verify it shows 1"',
      'default agent increments the counter · agent.act "increment the counter once and verify it shows 1"',
    ]);
    for (const run of document.runs) {
      expect(document.steps.filter((step) => step.run_id === run.id)).toHaveLength(2);
    }
    // File order is time order, whichever worker finished first.
    const starts = document.steps.map((step) => step.started_at);
    expect(starts).toEqual(starts.toSorted());
  });
});
