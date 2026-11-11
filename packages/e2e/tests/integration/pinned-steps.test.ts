/**
 * Pinned steps through the real browser engine and runner, driven by the
 * scripted model the trace cache suites use: `--pin` writes the recording
 * beside the test, a pinned step replays with the replay cache off and no
 * model, a recording pinned under another context fails as stale instead
 * of calling the model, and `steps: []` writes the actions into the call.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelInstance, Report } from '../../src/index.ts';
import { loopCalls } from '../helpers/fake-loop-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { actSteps, expectPassed, flowByTitle, flowsModel, flowsSuite } from '../helpers/trace-cache.ts';

const execFileAsync = promisify(execFile);
const FLOWS_FILE = 'tests/flows.e2e.ts';
const STEPS_FILE = 'tests/flows.e2e.steps.json';
const FLOWS = [flowByTitle('increments the counter'), flowByTitle('creates a company')];

/** No cache, so every replay below is the pin's. */
function config(model: ModelInstance) {
  return { tests: 'tests/**/*.e2e.ts', agents: { default: { model } }, cache: 'off' as const };
}

/** A model no step may call. */
function forbiddenModel(): ModelInstance {
  return flowsModel([]);
}

function stepsFile(project: FixtureProject): { steps: { test: string[]; inline?: true; recordedWith: Record<string, unknown>; trace: Record<string, unknown> }[] } {
  return JSON.parse(readFileSync(path.join(project.dir, STEPS_FILE), 'utf8')) as ReturnType<typeof stepsFile>;
}

describe('pinned steps', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let pinned: RunOutcome;
  let replayed: RunOutcome;
  let replayCalls = -1;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: flowsSuite(FLOWS, 'record') });
    pinned = await runExisting(project, { appUrl: app.url, config: config(flowsModel()), runOptions: { pin: 'new' } });
    replayed = await runExisting(project, { appUrl: app.url, config: config(forbiddenModel()) });
    replayCalls = loopCalls.length;
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('pins each passing step beside its test with the cache off', () => {
    expectPassed(pinned);
    assertValidReport(pinned.report);
    expect(existsSync(path.join(project.dir, '.e2e', 'cache'))).toBe(false);
    const { steps } = stepsFile(project);
    expect(steps.map((step) => step.test)).toEqual([['increments the counter'], ['creates a company']]);
    expect(JSON.stringify(steps)).not.toMatch(/E2E \d+ Company/u);
    expect(JSON.stringify(steps)).toContain('{{param:/name}}');
  });

  it('replays a pinned step with no model call and says it was pinned', () => {
    expectPassed(replayed);
    assertValidReport(replayed.report);
    expect(replayCalls).toBe(0);
    for (const flow of FLOWS) {
      for (const step of actSteps(replayed, flow.title)) expect(step.cache).toMatchObject({ mode: 'self-finalized', pinned: 'sidecar' });
    }
  });

  it('fails a step pinned under another engine contract as stale, and never calls the model', async () => {
    const original = readFileSync(path.join(project.dir, STEPS_FILE), 'utf8');
    try {
      const document = stepsFile(project);
      document.steps[0]!.recordedWith['engineSpiVersion'] = 999;
      writeFileSync(path.join(project.dir, STEPS_FILE), JSON.stringify(document));
      const stale = await runExisting(project, { appUrl: app.url, config: config(forbiddenModel()) });
      expect(loopCalls).toHaveLength(0);
      const [step] = actSteps(stale, 'increments the counter');
      expect(step?.status).toBe('failed');
      expect(step?.cache).toMatchObject({ mode: 'missed', reason: 'wrong-context', pinned: 'sidecar' });
      const result = stale.report.run.results.find((candidate) => candidate.titlePath.at(-1) === 'increments the counter');
      expect(result?.attempts.at(-1)?.error).toMatchObject({ code: 'REPLAY_STALE', message: expect.stringContaining('the engine contract (999 -> ') });
    } finally {
      writeFileSync(path.join(project.dir, STEPS_FILE), original);
    }
  }, 120_000);
});

describe("pins: 'required'", () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // The company flow opts out of pinning; the counter flow does not.
    const suite = flowsSuite(FLOWS, 'record').replace('{ params: { name: unique(name) } }', '{ params: { name: unique(name) }, pin: false }');
    project = createProject({ [FLOWS_FILE]: suite });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  function attemptError(outcome: RunOutcome, title: string): unknown {
    return outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title)?.attempts.at(-1)?.error;
  }

  it('fails a step with no pin instead of calling the model, and runs one that opts out', async () => {
    const required = await runExisting(project, { appUrl: app.url, config: { ...config(flowsModel()), pins: 'required' } });
    assertValidReport(required.report);
    expect(attemptError(required, 'increments the counter')).toMatchObject({ code: 'REPLAY_STALE', message: expect.stringContaining("this run requires pins (pins: 'required')") });
    expect(actSteps(required, 'increments the counter')[0]?.cache).toMatchObject({ mode: 'missed', reason: 'no-entry' });
    expect(attemptError(required, 'creates a company')).toBeUndefined();
    expect(loopCalls.length).toBeGreaterThan(0);
    expect(loopCalls.every((call) => !JSON.stringify(call).includes('increment the counter twice'))).toBe(true);
  }, 120_000);

  it('records under --pin whatever pins says, leaves out a step that opts out, and replays the pin', async () => {
    const pinned = await runExisting(project, { appUrl: app.url, config: { ...config(flowsModel()), pins: 'required' }, runOptions: { pin: 'new' } });
    expectPassed(pinned);
    expect(stepsFile(project).steps.map((step) => step.test)).toEqual([['increments the counter']]);

    const replayed = await runExisting(project, { appUrl: app.url, config: config(flowsModel()), runOptions: { pins: 'required' } });
    expectPassed(replayed);
    expect(actSteps(replayed, 'increments the counter')[0]?.cache).toMatchObject({ mode: 'self-finalized', pinned: 'sidecar' });
  }, 240_000);

  it("fails a step an executor with cache: 'off' runs, unless the call opts out", async () => {
    let reached = 0;
    const live = {
      name: 'live',
      cache: 'off' as const,
      async runStep() {
        reached += 1;
        return { status: 'passed' as const, summary: 'ran live' };
      },
    };
    const suite = `import { test } from 'e2e';

test('pinned', async ({ app, agent }) => {
  await app.open();
  await agent.act('look around');
});

test('opted out', async ({ app, agent }) => {
  await app.open();
  await agent.act('look around', { pin: false });
});
`;
    const liveProject = createProject({ [FLOWS_FILE]: suite });
    try {
      const outcome = await runExisting(liveProject, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: live } }, pins: 'required' } });
      expect(attemptError(outcome, 'pinned')).toMatchObject({ code: 'REPLAY_STALE', message: expect.stringContaining(`"live" declares cache: 'off', so nothing can pin it`) });
      expect(attemptError(outcome, 'opted out')).toBeUndefined();
      expect(reached).toBe(1);
    } finally {
      liveProject.cleanup();
    }
  }, 120_000);
});

/** The built CLI: only a plain Node process maps a test's stack to its source lines, which the inline write needs. */
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

/**
 * A config whose agent is an executor that taps Increment twice, and throws
 * when `E2E_FORBID_EXECUTOR` is set: a pinned step must never reach it.
 */
const CLI_CONFIG = `import { web } from '@e2e-dev/web';

const incrementId = (text) => {
  const line = text.split('\\n').find((candidate) => candidate.includes('button "Increment"'));
  return /#(\\S+)/.exec(line ?? '')?.[1];
};

export default {
  tests: 'tests/**/*.e2e.ts',
  cache: 'off',
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL } }],
  agents: {
    default: {
      executor: {
        name: 'two-tap',
        version: 'test',
        async runStep(context) {
          if (process.env.E2E_FORBID_EXECUTOR === '1') throw new Error('a pinned step reached the executor');
          for (let tap = 0; tap < 2; tap += 1) {
            const observation = await context.observe();
            await context.actions.tap({ id: incrementId(observation.text) });
          }
          return { status: 'passed', summary: 'tapped Increment twice' };
        },
      },
    },
  },
};
`;

const INLINE_TEST = `import { test, expect } from 'e2e';

test('increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice', {
    steps: [],
  });
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});
`;

describe('inline steps', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.mjs': CLI_CONFIG, [FLOWS_FILE]: INLINE_TEST });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  /** One CLI run; its report and what it printed, where the list reporter shows the runner's own stderr. */
  async function cli(env: NodeJS.ProcessEnv): Promise<{ report: Report; output: string }> {
    const outcome = await execFileAsync(process.execPath, [CLI, 'run'], {
      cwd: project.dir,
      env: { ...process.env, CI: '', APP_URL: app.url, ...env },
    }).catch((error: { stdout?: string; stderr?: string }) => error);
    const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as Report;
    return { report, output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}` };
  }

  /** The cache detail of the test's one act step. */
  function actCache(report: Report): unknown {
    return report.run.results[0]?.attempts.at(-1)?.steps.find((step) => step.api === 'agent.act')?.cache;
  }

  it('records an empty steps option into the call, then replays it from there, in CI too', async () => {
    const recorded = await cli({});
    expect(recorded.report.run.status, recorded.output).toBe('passed');
    expect(recorded.output).toContain('e2e: tests/flows.e2e.ts: 1 call pinned inline');
    const written = readFileSync(path.join(project.dir, FLOWS_FILE), 'utf8');
    expect(written).toBe(INLINE_TEST.replace('    steps: [],', `    steps: [
      { name: 'tap', target: { role: 'button', name: 'Increment' } },
      { name: 'tap', target: { role: 'button', name: 'Increment' } },
    ],`));
    expect(stepsFile(project).steps).toMatchObject([{ test: ['increments the counter'], inline: true }]);
    expect(stepsFile(project).steps[0]!.trace).not.toHaveProperty('actions');

    for (const env of [{ E2E_FORBID_EXECUTOR: '1' }, { E2E_FORBID_EXECUTOR: '1', CI: '1' }]) {
      const replayed = await cli(env);
      expect(replayed.report.run.status, replayed.output).toBe('passed');
      expect(actCache(replayed.report)).toMatchObject({ mode: 'self-finalized', pinned: 'inline' });
      expect(readFileSync(path.join(project.dir, FLOWS_FILE), 'utf8')).toBe(written);
    }
  }, 240_000);

  it('fails an empty steps option in CI instead of reaching the agent', async () => {
    writeFileSync(path.join(project.dir, FLOWS_FILE), INLINE_TEST);
    const ci = await cli({ E2E_FORBID_EXECUTOR: '1', CI: '1' });
    expect(ci.report.run.status).not.toBe('passed');
    expect(ci.report.run.results[0]?.attempts.at(-1)?.error).toMatchObject({ code: 'REPLAY_STALE', message: expect.stringContaining('its steps option is empty') });
    expect(ci.output).not.toContain('a pinned step reached the executor');
    expect(readFileSync(path.join(project.dir, FLOWS_FILE), 'utf8')).toBe(INLINE_TEST);
  }, 240_000);
});
