/**
 * `e2e explore` end to end against the fixture app, with one scripted model
 * serving both surfaces: the planner's structured call and the explorer's
 * tool loop. The run goes through the real runner in-process, so the report,
 * the exit code, the finding evidence, and the summary rows are the ones a
 * user gets.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, defineTool } from '../../src/agent/public.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { explore, type ExploreOptions, type ExploreOutcome } from '../../src/explore/index.ts';
import { FINDING_TOOL_NAME } from '../../src/explore/executor.ts';
import type { ModelInstance } from '../../src/types.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall, type LoopToolCall } from '../helpers/fake-loop-model.ts';
import { fakeCalls, installFakeModel, type FakeCall } from '../helpers/fake-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';
import { playwright } from '@e2edev/playwright';
import { z } from 'zod';

type PlanAnswer = { decision: 'step'; title: string; instruction: string } | { decision: 'finish'; summary: string };

/**
 * One model for both paths: a request offering `complete_step` is a step of
 * the explorer's loop; anything else is the planner's structured call.
 */
function installExploreModel(options: {
  plan: (call: FakeCall) => PlanAnswer;
  loop: (call: LoopCall) => readonly LoopToolCall[];
}): ModelInstance {
  const loop = installFakeLoopModel(options.loop) as ModelInstance & { doGenerate: (request: unknown) => Promise<unknown> };
  const single = installFakeModel(options.plan) as ModelInstance & { doGenerate: (request: unknown) => Promise<unknown> };
  return {
    ...single,
    provider: 'fake',
    modelId: 'scripted-explore',
    doGenerate: (request: { tools?: readonly { name: string }[] }) =>
      request.tools?.some((tool) => tool.name === 'complete_step') === true ? loop.doGenerate(request) : single.doGenerate(request),
  } as ModelInstance;
}

/** The finding the scripted explorer reports on the home page. */
const COUNTER_FINDING = {
  title: 'Counter starts at 0 with no label of what it counts',
  kind: 'issue',
  severity: 3,
  expected: 'The counter says what it counts',
  actual: 'output "Counter" reads 0',
  reproduction: ['Open the home page', 'Look at the counter next to Increment'],
};

async function runExplore(
  project: FixtureProject,
  app: FixtureApp,
  model: ModelInstance,
  options: Partial<ExploreOptions> & { projectAgent?: StepExecutor | undefined } = {},
): Promise<ExploreOutcome> {
  const { projectAgent, ...rest } = options;
  const notices: string[] = [];
  const outcome = await explore({
    cwd: project.dir,
    rawConfig: {
      targets: [{ name: 'web', engine: playwright({ url: app.url }) }] as never,
      agents: { default: projectAgent ?? { model } },
      // The scripted loop answers instantly; the deterministic engine budget is the one that matters.
      actionTimeout: 10_000,
    },
    goal: 'Explore the home page and find bugs',
    maxSteps: 2,
    timeoutMs: 180_000,
    notice: (message) => notices.push(message),
    ...rest,
  });
  return Object.assign(outcome, { notices });
}

describe('e2e explore', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({});
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('plans steps, records the finding with its evidence, and fails the run for the issue', async () => {
    const planPrompts: string[] = [];
    const model = installExploreModel({
      plan: (call) => {
        planPrompts.push(call.instruction);
        if (planPrompts.length === 1) return { decision: 'step', title: 'Counter', instruction: 'Tap Increment once and check the counter' };
        return { decision: 'finish', summary: 'The counter works but says nothing about what it counts.' };
      },
      loop: (call) => {
        if (call.turn === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }];
        if (call.turn === 2) return [{ toolName: FINDING_TOOL_NAME, input: COUNTER_FINDING }];
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Counter went to 1' } }];
      },
    });
    const outcome = await runExplore(project, app, model);

    expect(outcome.report.run.errors).toEqual([]);
    // The planner saw the goal each time, then the record of the step and its finding.
    expect(planPrompts).toHaveLength(2);
    expect(planPrompts[0]).toContain('Goal: Explore the home page and find bugs');
    expect(planPrompts[1]).toContain('1. [passed] Counter — Counter went to 1');
    expect(planPrompts[1]).toContain(`- [issue, severity 3] ${COUNTER_FINDING.title}`);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.status).toBe('failed');
    assertValidReport(outcome.report);
    const record = outcome.report.run.explore!;
    expect(record).toMatchObject({
      goal: 'Explore the home page and find bugs',
      budgets: { maxSteps: 2, timeoutMs: 180_000 },
      ended: 'finished',
      summary: 'The counter works but says nothing about what it counts.',
    });
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0]).toMatchObject({ index: 1, title: 'Counter', status: 'passed', summary: 'Counter went to 1' });
    expect(record.findings).toHaveLength(1);
    const finding = record.findings[0]!;
    expect(finding).toMatchObject({ step: 1, kind: 'issue', severity: 3, title: COUNTER_FINDING.title, path: '/' });
    expect(finding.observationRevision).toBeDefined();
    expect(finding.screenshot).toMatch(/^explore\/.+\/finding-1\.png$/);
    expect(existsSync(path.join(project.dir, '.e2e', 'artifacts', ...finding.screenshot!.split('/')))).toBe(true);

    // The one result is the exploration, under the virtual file, failed by the issue.
    expect(outcome.report.run.results).toHaveLength(1);
    const result = outcome.report.run.results[0]!;
    expect(result.file).toBe('explore');
    expect(result.titlePath).toEqual(['Explore the home page and find bugs']);
    expect(result.attempts.at(-1)!.error?.message).toContain('exploration found 1 issue(s)');
    // The planner ran as an extract step, the charter as an act step, in the attempt's timeline.
    expect(result.attempts[0]!.steps.map((step) => step.api)).toEqual(['app.open', 'agent.extract', 'agent.act', 'agent.extract']);
    // The explorer's loop saw the finding tool beside the grammar.
    expect(loopCalls[0]!.toolNames).toContain(FINDING_TOOL_NAME);
    // The planner's calls carried the goal as trusted context.
    expect(fakeCalls[0]!.system).toContain('Exploration goal: Explore the home page and find bugs');
    // The written report is the outcome's document.
    const written = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as typeof outcome.report;
    expect(written.run.explore).toEqual(record);
  }, 120_000);

  it('passes with warnings only, and offers the project tools of a createAgent config', async () => {
    let plans = 0;
    const seen: string[][] = [];
    const model = installExploreModel({
      plan: () => {
        plans += 1;
        return plans === 1
          ? { decision: 'step', title: 'Menu', instruction: 'Open the menu' }
          : { decision: 'finish', summary: 'Only polish items.' };
      },
      loop: (call) => {
        seen.push([...call.toolNames]);
        if (call.turn === 1) return [{ toolName: 'ping', input: {} }];
        if (call.turn === 2) return [{ toolName: FINDING_TOOL_NAME, input: { ...COUNTER_FINDING, kind: 'warning', severity: 1 } }];
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Menu toggles' } }];
      },
    });
    const ping = defineTool(
      { description: 'answers pong', inputSchema: z.object({}), execute: async () => 'pong' },
      { mutates: false },
    );
    const outcome = await runExplore(project, app, model, {
      projectAgent: createAgent({ model: model as never, tools: { ping }, system: 'Project guidance line.' }),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');
    expect(seen[0]).toContain('ping');
    expect(seen[0]).toContain(FINDING_TOOL_NAME);
    expect(loopCalls.at(-1)!.toolResults).toContain('pong');
    expect(outcome.report.run.explore!.findings[0]).toMatchObject({ kind: 'warning', severity: 1 });
    expect((outcome as unknown as { notices: string[] }).notices).toEqual([]);
  }, 120_000);

  it('is blocked when the agent explores nothing, and replaces a custom executor with a notice', async () => {
    const model = installExploreModel({
      plan: () => ({ decision: 'finish', summary: 'Nothing here.' }),
      loop: () => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'unused' } }],
    });
    const custom: StepExecutor = {
      name: 'house-brain',
      runStep: async () => ({ status: 'passed', summary: 'never runs' }),
    };
    const outcome = await runExplore(project, app, model, {
      projectAgent: { model, executor: custom } as never,
    });
    expect(outcome.status).toBe('blocked');
    expect(outcome.report.run.explore).toMatchObject({ ended: 'finished', steps: [], findings: [] });
    expect(outcome.report.run.results[0]!.attempts[0]!.error?.code).toBe('AUTOMATION_UNSUPPORTED');
    expect((outcome as unknown as { notices: string[] }).notices).toEqual([
      'the configured agent "house-brain" is a custom executor; explore runs the built-in agent instead',
    ]);
  }, 120_000);

  it('explores the first of several targets, opening its app first, and leaves a malformed reporters value to config validation', async () => {
    const model = installExploreModel({
      plan: () => ({ decision: 'finish', summary: 'Looked around.' }),
      loop: () => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'unused' } }],
    });
    // The first target leaves its name to the platform; the run must still explore exactly that one.
    const notices: string[] = [];
    const outcome = await explore({
      cwd: project.dir,
      rawConfig: {
        targets: [{ engine: playwright({ url: app.url }) }, { name: 'second', engine: playwright({ url: app.url }) }] as never,
        agents: { default: { model } },
      },
      goal: 'Look around',
      maxSteps: 1,
      timeoutMs: 180_000,
      notice: (message) => notices.push(message),
    });
    expect(notices).toEqual(['exploring target "web"; pass --target to explore another']);
    expect(outcome.report.run.results.map((result) => result.targetId)).toEqual(['web']);
    expect(outcome.report.run.results[0]!.attempts[0]!.steps[0]!.api).toBe('app.open');

    const malformed = await explore({
      cwd: project.dir,
      rawConfig: { targets: [{ name: 'web', engine: playwright({ url: app.url }) }] as never, agents: { default: { model } }, reporters: 'json' as never },
      goal: 'Look around',
    });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.report.run.errors[0]).toMatchObject({ code: 'INVALID_CONFIG' });
  }, 120_000);

  it('builds the explorer from the agent --agent names, keeps the other agents, and rejects an unknown name before anything starts', async () => {
    let plans = 0;
    const seen: string[][] = [];
    const model = installExploreModel({
      plan: () => {
        plans += 1;
        return plans === 1 ? { decision: 'step', title: 'Look', instruction: 'Look around' } : { decision: 'finish', summary: 'Seen everything there was.' };
      },
      loop: (call) => {
        seen.push([...call.toolNames]);
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'looked' } }];
      },
    });
    const ping = defineTool({ description: 'answers pong', inputSchema: z.object({}), execute: async () => 'pong' }, { mutates: false });
    const notices: string[] = [];
    const outcome = await explore({
      cwd: project.dir,
      rawConfig: {
        targets: [{ name: 'web', engine: playwright({ url: app.url }) }] as never,
        agents: { default: { model }, ux: createAgent({ model: model as never, tools: { ping } }) },
      },
      goal: 'Look around',
      agent: 'ux',
      maxSteps: 1,
      timeoutMs: 180_000,
      notice: (message) => notices.push(message),
    });
    expect(outcome.status).toBe('passed');
    expect(notices).toEqual(['exploring with agent "ux"']);
    // The ux agent's tool is in the explorer's vocabulary.
    expect(seen[0]).toContain('ping');
    expect(seen[0]).toContain(FINDING_TOOL_NAME);

    await expect(
      explore({ cwd: project.dir, rawConfig: { targets: [{ name: 'web', engine: playwright({ url: app.url }) }] as never, agents: { default: { model } } }, agent: 'nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: 'unknown agent "nope"; configured: default' });
  }, 120_000);

  it('lets the explorer sign in with a configured credential through type_secret, never seeing the password', async () => {
    const planPrompts: string[] = [];
    let fillResult: string | undefined;
    const model = installExploreModel({
      plan: (call) => {
        planPrompts.push(call.instruction);
        return planPrompts.length === 1 ? { decision: 'step', title: 'Sign in', instruction: 'Fill the password for the ada account' } : { decision: 'finish', summary: 'The password field takes the credential.' };
      },
      loop: (call) => {
        if (call.turn === 1) return [{ toolName: 'type_secret', input: { target: nodeIdFor(call.prompt, /textbox "Password"/), name: 'ada' } }];
        fillResult = call.lastToolResult;
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Filled the password' } }];
      },
    });
    const outcome = await explore({
      cwd: project.dir,
      rawConfig: {
        targets: [{ name: 'web', engine: playwright({ url: app.url }) }] as never,
        agents: { default: { model } },
        credentials: { ada: { username: 'ada@example.test', password: 'bookworm' } },
      },
      goal: 'Sign in and look around',
      maxSteps: 1,
      timeoutMs: 180_000,
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.status).toBe('passed');
    expect(planPrompts[0]).toContain('- ada (username: ada@example.test)');
    expect(loopCalls[0]!.toolNames).toContain('type_secret');
    expect(loopCalls[0]!.prompt).toContain('"kind":"secret","name":"ada"');
    expect(fillResult).toContain('Filled secret "ada"');
    // The plaintext reaches neither the planner nor the explorer.
    expect(planPrompts.join('\n')).not.toContain('bookworm');
    expect(loopCalls.map((call) => call.prompt).join('\n')).not.toContain('bookworm');
  }, 120_000);

  it('rejects a goal past the ceiling before anything starts', async () => {
    await expect(explore({ cwd: project.dir, rawConfig: {}, goal: 'x'.repeat(2_001) })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(explore({ cwd: project.dir, rawConfig: {}, maxSteps: 13 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
