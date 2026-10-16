/** A model the provider refuses stops the run once, naming the model, from whichever tier met it first, and once only across two workers. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { explore } from '../../src/explore/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';
import { REFUSAL_EXPLANATION, refusedCopilotFailure, refusedCopilotModel } from '../helpers/unserved-copilot-model.ts';
import { web } from '@e2e-dev/web';

const JUDGE = `test('judges', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page is open');
});`;

const ACT = `test('acts', async ({ app, agent }) => {
  await app.open();
  await agent.act('do the thing');
});`;

/** One suite file of the given tests. */
function suite(...tests: readonly string[]): string {
  return `import { test } from '@e2e-dev/web';\n\n${tests.join('\n\n')}\n`;
}

const WORKERS_CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { refusedCopilotModel } from '../../helpers/unserved-copilot-model.ts';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  tests: 'tests/**/*.e2e.ts',
  workers: 2,
  cache: 'off',
  agents: { default: { model: refusedCopilotModel() } },
} satisfies E2EConfig;
`;

/** A hand-written executor with its own `copilot()` call: the refusal leaves `runStep` as the SDK's error, mark and all. */
const HOUSE_BRAIN: StepExecutor = {
  name: 'house-brain',
  runStep: async () => {
    throw refusedCopilotFailure();
  },
};

const ONE_RUN_ERROR = [expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining(REFUSAL_EXPLANATION) })];

/** The test that met it is cut short by the run's stop, its one attempt carrying the code; the next never starts. */
const CUT_SHORT = [
  ['interrupted', 1, 'MODEL_UNAVAILABLE'],
  ['skipped', 0, undefined],
];

describe('a model the provider does not serve', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    { tier: 'a judgment', files: suite(JUDGE, ACT), agents: { default: { model: refusedCopilotModel() } } },
    { tier: 'an act step', files: suite(ACT, JUDGE), agents: { default: { model: refusedCopilotModel() } } },
    { tier: 'a custom executor calling the model itself', files: suite(ACT, JUDGE), agents: { default: { executor: HOUSE_BRAIN } } },
  ])('stops the run once with MODEL_UNAVAILABLE naming the model, met by $tier', async ({ files, agents }) => {
    const project: FixtureProject = createProject({ 'tests/unserved.e2e.ts': files });
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', cache: 'off', agents },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual(ONE_RUN_ERROR);
      expect(outcome.report.run.results.map((result) => [result.status, result.attempts.length, result.attempts[0]?.error?.code])).toEqual(CUT_SHORT);
    } finally {
      project.cleanup();
    }
  }, 60_000);

  it('reports it once when two workers meet it at the same time', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/one.e2e.ts': suite(JUDGE), 'tests/two.e2e.ts': suite(ACT) },
      { appUrl: app.url, configSource: WORKERS_CONFIG },
    );
    try {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual(ONE_RUN_ERROR);
      expect(outcome.report.run.results.filter((result) => result.status === 'passed')).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('ends e2e explore the same way, at the planner call that opens it', async () => {
    const project = createProject({});
    try {
      const outcome = await explore({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'web', engine: web(), app: { url: app.url } }] as never,
          agents: { default: { model: refusedCopilotModel() } },
        },
        goal: 'Explore the home page and find bugs',
        maxSteps: 2,
        timeoutMs: 180_000,
        notice: () => undefined,
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual(ONE_RUN_ERROR);
    } finally {
      project.cleanup();
    }
  }, 60_000);
});
