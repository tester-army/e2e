/**
 * A model the provider does not serve to this account stops the run once,
 * naming the model, whichever tier met it first: the judgment adapter behind
 * `agent.assert`, the act loop behind `agent.act`, or the planner that opens
 * `e2e explore`; and once only when two workers meet it at the same time.
 * Before, every test failed in turn with the provider's bare sentence as
 * `MODEL_PROVIDER_FAILED`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore } from '../../src/explore/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';
import { REFUSAL_EXPLANATION, refusedCopilotModel } from '../helpers/unserved-copilot-model.ts';
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

const ONE_RUN_ERROR = [expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining(REFUSAL_EXPLANATION) })];

describe('a model the provider does not serve', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    { tier: 'a judgment', files: suite(JUDGE, ACT) },
    { tier: 'an act step', files: suite(ACT, JUDGE) },
  ])('stops the run once with MODEL_UNAVAILABLE naming the model, met by $tier', async ({ files }) => {
    const project: FixtureProject = createProject({ 'tests/unserved.e2e.ts': files });
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', cache: 'off', agents: { default: { model: refusedCopilotModel() } } },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual(ONE_RUN_ERROR);
      // The test that met it is cut short by the run's stop, its one attempt carrying the code; the next never starts.
      expect(outcome.report.run.results.map((result) => [result.status, result.attempts.length, result.attempts[0]?.error?.code])).toEqual([
        ['interrupted', 1, 'MODEL_UNAVAILABLE'],
        ['skipped', 0, undefined],
      ]);
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
