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
import { web } from '@e2e-dev/web';
import { z } from 'zod';

// The session runs collect the project's own test files, which register
// through the built package's `e2e` self-reference; the built explore shares
// that registry. The specifier is non-literal so typechecking needs no build.
const builtExploreModule = '../../dist/explore/index.js';
const { explore: exploreBuilt } = (await import(builtExploreModule)) as typeof import('../../src/explore/index.ts');

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
  // Strict providers want every planner field present; the scripts name only the ones they use.
  const single = installFakeModel((call) => ({ title: '', instruction: '', summary: '', ...options.plan(call) })) as ModelInstance & { doGenerate: (request: unknown) => Promise<unknown> };
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
      targets: [{ name: 'web', engine: web({ url: app.url }) }] as never,
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

  it('keeps a screenshot per finding when the model reports two in one turn', async () => {
    const SECOND_FINDING = { ...COUNTER_FINDING, title: 'Increment button has no accessible description', severity: 2 };
    const model = installExploreModel({
      plan: (call) =>
        call.instruction.includes('(none yet')
          ? { decision: 'step', title: 'Counter', instruction: 'Look at the counter' }
          : { decision: 'finish', summary: 'Two defects on the home page.' },
      loop: (call) => {
        // Read-only tools run in parallel: both findings pick their evidence name before either is recorded.
        if (call.turn === 1) {
          return [
            { toolName: FINDING_TOOL_NAME, input: COUNTER_FINDING },
            { toolName: FINDING_TOOL_NAME, input: SECOND_FINDING },
          ];
        }
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Looked' } }];
      },
    });
    const outcome = await runExplore(project, app, model);
    const record = outcome.report.run.explore!;
    expect(record.findings.map((finding) => finding.title).toSorted()).toEqual([COUNTER_FINDING.title, SECOND_FINDING.title].toSorted());
    const artifacts = outcome.report.run.results[0]!.attempts[0]!.artifacts;
    const paths = record.findings.map((finding) => artifacts.find((artifact) => artifact.id === finding.artifactId)?.path);
    expect(paths.every((entry) => entry !== undefined)).toBe(true);
    expect(new Set(paths).size).toBe(2);
    expect(paths.map((entry) => entry!.split('/').at(-1)).toSorted()).toEqual(['finding-1.png', 'finding-2.png']);
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

    // The one result is the exploration, under the virtual file, failed by the issue.
    expect(outcome.report.run.results).toHaveLength(1);
    const result = outcome.report.run.results[0]!;
    expect(result.file).toBe('explore');
    // The evidence is an ordinary screenshot artifact of the attempt, attached to the act step that reported it.
    const attempt = result.attempts[0]!;
    const evidence = attempt.artifacts.find((artifact) => artifact.id === finding.artifactId);
    expect(evidence).toMatchObject({ kind: 'screenshot', mediaType: 'image/png', producer: { kind: 'step' } });
    expect(evidence!.path).toMatch(/\/finding-1\.png$/);
    expect(existsSync(path.join(project.dir, '.e2e', 'artifacts', ...evidence!.path!.split('/')))).toBe(true);
    expect(attempt.steps.find((step) => step.api === 'agent.act')!.artifacts).toContain(finding.artifactId);
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

  it.each([
    { firstStatus: 'blocked', expectedStatus: 'blocked', exitCode: 3 },
    { firstStatus: 'passed', expectedStatus: 'passed', exitCode: 0 },
  ] as const)('reports $expectedStatus when the first charter $firstStatus and the second was blocked', async ({ firstStatus, expectedStatus, exitCode }) => {
    let plans = 0;
    const model = installExploreModel({
      plan: () => {
        plans += 1;
        if (plans === 1) return { decision: 'step', title: 'Catalog', instruction: 'Explore the catalog' };
        if (plans === 2) return { decision: 'step', title: 'Account', instruction: 'Explore the account' };
        return { decision: 'finish', summary: 'Account was unavailable; no product issues were confirmed.' };
      },
      loop: () => [{
        toolName: 'complete_step',
        input: plans === 1 && firstStatus === 'passed'
          ? { status: 'passed', summary: 'Catalog is reachable' }
          : { status: 'blocked', summary: 'Required service is unavailable', errorCode: 'ENVIRONMENT_UNAVAILABLE' },
      }],
    });
    const outcome = await runExplore(project, app, model);
    expect(outcome.status).toBe(expectedStatus);
    expect(outcome.exitCode).toBe(exitCode);
    expect(outcome.explore.steps.map((step) => step.status)).toEqual([firstStatus, 'blocked']);
    expect(outcome.explore.findings).toEqual([]);
    const attempt = outcome.report.run.results[0]!.attempts[0]!;
    expect(attempt.steps.filter((step) => step.api === 'agent.act').map((step) => step.status)).toEqual([firstStatus, 'blocked']);
    if (expectedStatus === 'blocked') {
      expect(attempt.error).toMatchObject({ code: 'ENVIRONMENT_UNAVAILABLE', message: expect.stringContaining('Required service is unavailable') });
    } else {
      expect(attempt.error).toBeUndefined();
    }
    assertValidReport(outcome.report);
  }, 120_000);

  it('explores the first of several targets, opening its app first, and rejects a config that does not resolve before anything starts', async () => {
    const model = installExploreModel({
      plan: () => ({ decision: 'finish', summary: 'Looked around.' }),
      loop: () => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'unused' } }],
    });
    // The first target leaves its name to the platform; the run must still explore exactly that one.
    const notices: string[] = [];
    const outcome = await explore({
      cwd: project.dir,
      rawConfig: {
        targets: [{ engine: web({ url: app.url }) }, { name: 'second', engine: web({ url: app.url }) }] as never,
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

    const config = { targets: [{ name: 'web', engine: web({ url: app.url }) }] as never, agents: { default: { model } } };
    await expect(explore({ cwd: project.dir, rawConfig: { ...config, reporters: 'json' as never }, goal: 'Look around' })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: /reporters must be an array/,
    });
    await expect(explore({ cwd: project.dir, rawConfig: config, target: 'nope' })).rejects.toMatchObject({
      code: 'UNKNOWN_TARGET',
      message: /unknown target ID "nope"; the config declares "web"/,
    });
  }, 120_000);

  it('runs as the agent --agent names, built from it, keeps the other agents, and rejects an unknown name before anything starts', async () => {
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
        targets: [{ name: 'web', engine: web({ url: app.url }) }] as never,
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
    // The steps record the agent they ran as, like `e2e run --agent`.
    const steps = outcome.report.run.results[0]!.attempts[0]!.steps.filter((step) => step.api.startsWith('agent.'));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((step) => step.agent)).toEqual(steps.map(() => 'ux'));
    // The ux agent's tool is in the explorer's vocabulary.
    expect(seen[0]).toContain('ping');
    expect(seen[0]).toContain(FINDING_TOOL_NAME);

    await expect(
      explore({ cwd: project.dir, rawConfig: { targets: [{ name: 'web', engine: web({ url: app.url }) }] as never, agents: { default: { model } } }, agent: 'nope' }),
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
        targets: [{ name: 'web', engine: web({ url: app.url }) }] as never,
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

  it('rejects a goal past the ceiling, a budget out of range, and a credential inventory that would not fit a step before anything starts', async () => {
    // A config that resolves, so only the flag can be what rejects.
    const resolvable = { targets: [{ platform: 'web' }] };
    await expect(explore({ cwd: project.dir, rawConfig: resolvable, goal: 'x'.repeat(2_001) })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(explore({ cwd: project.dir, rawConfig: resolvable, maxSteps: 13 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const credentials = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`account-${String(i)}`, { username: `${'u'.repeat(200)}@example.test`, password: 'password' }]),
    );
    await expect(
      explore({ cwd: project.dir, rawConfig: { targets: [{ name: 'web', engine: web({ url: app.url }) }] as never, credentials } }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('400 account(s) serialize to') });
  });
});

describe('e2e explore --session', () => {
  /**
   * Three setups, one that saves a marker without any secret, one that has
   * the project's agent save it, and one that fills a password, and an
   * ordinary test that must never run under explore.
   */
  const files = {
    'tests/acted.setup.e2e.ts': `import { test } from 'e2e';
test.setup('has the agent save the marker', { sessions: ['acted'] }, async ({ app, agent, session }) => {
  await app.open('/storage');
  await agent.act('Tap Save marker');
  await session.save('acted');
});`,
    'tests/marker.setup.e2e.ts': `import { test } from 'e2e';
test.setup('saves the marker', { sessions: ['marker'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await session.save('marker');
});`,
    'tests/password.setup.e2e.ts': `import { test, credentials } from 'e2e';
test.setup('fills the password', { sessions: ['signed-in'] }, async ({ app, screen, session }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill(credentials.user('ada').password);
  await session.save('signed-in');
});`,
    'tests/other.e2e.ts': `import { test } from 'e2e';
test('never runs under explore', async () => {
  throw new Error('an ordinary test ran');
});`,
  };
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject(files);
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const exploreWithSession = (model: ModelInstance, session: string): Promise<ExploreOutcome> =>
    exploreBuilt({
      cwd: project.dir,
      rawConfig: {
        targets: [{ name: 'web', engine: web({ url: app.url }) }] as never,
        agents: { default: { model } },
        credentials: { ada: { username: 'ada@example.test', password: 'bookworm' } },
        actionTimeout: 10_000,
      },
      goal: 'Explore the storage page',
      session,
      maxSteps: 1,
      timeoutMs: 180_000,
    });

  /** The titles of the pairs that ran, sorted: the report also lists the ones selection left out, as skipped. */
  const ran = (outcome: ExploreOutcome) =>
    outcome.report.run.results
      .filter((result) => result.status !== 'skipped')
      .map((result) => result.titlePath.at(-1))
      .toSorted();

  it('runs only the setup that saves the session, then explores from it, signed in, with screenshots when no secret was filled', async () => {
    const planPrompts: string[] = [];
    let storageScreen = '';
    const model = installExploreModel({
      plan: (call) => {
        planPrompts.push(call.instruction);
        return planPrompts.length === 1
          ? { decision: 'step', title: 'Storage', instruction: 'Check the storage marker' }
          : { decision: 'finish', summary: 'The restored marker is shown.' };
      },
      loop: (call) => {
        if (call.turn === 1) return [{ toolName: 'navigate', input: { url: `${app.url}/storage` } }];
        if (call.turn === 2) {
          storageScreen = call.lastToolResult;
          return [{ toolName: FINDING_TOOL_NAME, input: COUNTER_FINDING }];
        }
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Marker is saved' } }];
      },
    });
    const outcome = await exploreWithSession(model, 'marker');

    expect(outcome.report.run.errors).toEqual([]);
    assertValidReport(outcome.report);
    expect(ran(outcome)).toEqual(['Explore the storage page', 'saves the marker']);
    expect(outcome.report.run.results.find((result) => result.titlePath.at(-1) === 'saves the marker')!.status).toBe('passed');
    // The restored local storage is what the explorer found on the page.
    expect(storageScreen).toMatch(/"Marker"[^\n]*saved/);
    // Restoring leaves no page open, so the exploration still opens the app first.
    const attempt = outcome.report.run.results.find((result) => result.file === 'explore')!.attempts[0]!;
    expect(attempt.steps[0]!.api).toBe('app.open');
    // The planner and the explorer both know they start signed in.
    expect(planPrompts[0]).toContain('The app starts signed in: the run restored the session "marker"');
    expect(planPrompts[0]).toContain('work as the signed-in user rather than signing in again');
    expect(loopCalls[0]!.system).toContain('restored the session "marker"');
    // No secret was filled on the way, so the finding keeps its screenshot.
    const finding = outcome.explore.findings[0]!;
    expect(finding.artifactId).toBeDefined();
    expect(attempt.artifacts.find((artifact) => artifact.id === finding.artifactId)).toMatchObject({ kind: 'screenshot' });
  }, 120_000);

  it('keeps the pixels of a session whose setup filled a secret withheld, so its findings carry no screenshot', async () => {
    const model = installExploreModel({
      plan: (call) =>
        call.instruction.includes('(none yet')
          ? { decision: 'step', title: 'Home', instruction: 'Look at the home page' }
          : { decision: 'finish', summary: 'One finding without evidence.' },
      loop: (call) =>
        call.turn === 1
          ? [{ toolName: FINDING_TOOL_NAME, input: COUNTER_FINDING }]
          : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Looked' } }],
    });
    const outcome = await exploreWithSession(model, 'signed-in');

    expect(outcome.report.run.errors).toEqual([]);
    expect(ran(outcome)).toEqual(['Explore the storage page', 'fills the password']);
    expect(outcome.explore.findings).toHaveLength(1);
    expect(outcome.explore.findings[0]!.artifactId).toBeUndefined();
    expect(JSON.stringify(outcome.report)).not.toContain('bookworm');
  }, 120_000);

  it('runs an agentic setup as the project agent, not the explorer: its own prompt, tools, and cache, and no findings', async () => {
    const setupCalls: LoopCall[] = [];
    const model = installExploreModel({
      plan: (call) =>
        call.instruction.includes('(none yet')
          ? { decision: 'step', title: 'Storage', instruction: 'Look at the storage page' }
          : { decision: 'finish', summary: 'Looked around the storage page.' },
      loop: (call) => {
        if (call.system.includes('Exploration mode')) {
          return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Looked' } }];
        }
        setupCalls.push(call);
        if (setupCalls.length === 1) {
          // Offered or not, the setup's model tries to report a finding; only the explorer may record one.
          return [
            { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Save marker"/) } },
            { toolName: FINDING_TOOL_NAME, input: COUNTER_FINDING },
          ];
        }
        return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'Saved the marker' } }];
      },
    });
    const outcome = await exploreWithSession(model, 'acted');

    expect(outcome.report.run.errors).toEqual([]);
    expect(ran(outcome)).toEqual(['Explore the storage page', 'has the agent save the marker']);
    const setup = outcome.report.run.results.find((result) => result.titlePath.at(-1) === 'has the agent save the marker')!;
    expect(setup.status).toBe('passed');
    expect(setupCalls.length).toBeGreaterThan(0);
    for (const call of setupCalls) {
      expect(call.system).not.toContain('Exploration mode');
      expect(call.system).not.toContain('Exploration goal');
      expect(call.toolNames).not.toContain(FINDING_TOOL_NAME);
    }
    expect(outcome.explore.findings).toEqual([]);
    // The setup keeps the project's trace cache; the exploration runs without it.
    const setupAct = setup.attempts[0]!.steps.find((step) => step.api === 'agent.act')!;
    expect(setupAct.cache).toBeDefined();
    const exploreAttempt = outcome.report.run.results.find((result) => result.file === 'explore')!.attempts[0]!;
    expect(exploreAttempt.steps.filter((step) => step.api === 'agent.act').map((step) => step.cache)).toEqual([undefined]);
  }, 120_000);

  it('fails an unknown session at collection, naming the declared ones, before anything runs', async () => {
    const model = installExploreModel({
      plan: () => ({ decision: 'finish', summary: 'never asked' }),
      loop: () => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'never asked' } }],
    });
    const outcome = await exploreWithSession(model, 'markr');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.status).toBe('error');
    expect(outcome.report.run.results).toEqual([]);
    expect(outcome.report.run.errors).toEqual([
      expect.objectContaining({
        phase: 'collection',
        code: 'COLLECTION_ERROR',
        message: expect.stringMatching(/^test "Explore the storage page" in explore consumes session "markr" but no setup test produces it; setup tests declare "acted", "marker", "signed-in"; did you mean "marker"\?$/),
      }),
    ]);
    expect(fakeCalls).toEqual([]);
  });
});
