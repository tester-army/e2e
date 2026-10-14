/**
 * A model the provider does not serve to this account stops the run once,
 * naming the model, whichever tier met it first: the judgment adapter behind
 * `agent.assert`, or the act loop behind `agent.act`. Before, every test
 * failed in turn with the provider's bare sentence as `MODEL_PROVIDER_FAILED`.
 */

import { APICallError } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explore } from '../../src/explore/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { createScriptedInstance } from '../helpers/scripted-model.ts';
import { web } from '@e2e-dev/web';

const JUDGES_FIRST = `
import { test } from '@e2e-dev/web';

test('judges', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page is open');
});

test('would act next', async ({ app, agent }) => {
  await app.open();
  await agent.act('do the thing');
});
`;

const ACTS_FIRST = `
import { test } from '@e2e-dev/web';

test('acts', async ({ app, agent }) => {
  await app.open();
  await agent.act('do the thing');
});

test('would judge next', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page is open');
});
`;

const COPILOT_BODY =
  '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}';

/** A Copilot-shaped model whose every call is refused the way a plan that does not include it answers. */
function refusedModel() {
  return createScriptedInstance('github-copilot.chat', 'claude-haiku-4.5', async () => {
    throw new APICallError({
      message: 'The requested model is not supported.',
      url: 'https://api.githubcopilot.com/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: COPILOT_BODY,
      data: JSON.parse(COPILOT_BODY) as unknown,
    });
  });
}

describe('a model the provider does not serve', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    { tier: 'a judgment', suite: JUDGES_FIRST },
    { tier: 'an act step', suite: ACTS_FIRST },
  ])('stops the run once with MODEL_UNAVAILABLE naming the model, met by $tier', async ({ suite }) => {
    const project: FixtureProject = createProject({ 'tests/unserved.e2e.ts': suite });
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', cache: 'off', agents: { default: { model: refusedModel() } } },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([
        expect.objectContaining({
          code: 'MODEL_UNAVAILABLE',
          message: expect.stringContaining(
            'GitHub Copilot does not serve claude-haiku-4.5 to this account: the plan does not include it, or it is turned off in Copilot settings on GitHub',
          ),
        }),
      ]);
      // The test that met it is cut short by the run's stop, its one attempt carrying the code; the next never starts.
      expect(outcome.report.run.results.map((result) => [result.status, result.attempts.length, result.attempts[0]?.error?.code])).toEqual([
        ['interrupted', 1, 'MODEL_UNAVAILABLE'],
        ['skipped', 0, undefined],
      ]);
    } finally {
      project.cleanup();
    }
  }, 60_000);

  it('ends e2e explore the same way, at the planner call that opens it', async () => {
    const project = createProject({});
    try {
      const outcome = await explore({
        cwd: project.dir,
        rawConfig: {
          targets: [{ name: 'web', engine: web(), app: { url: app.url } }] as never,
          agents: { default: { model: refusedModel() } },
        },
        goal: 'Explore the home page and find bugs',
        maxSteps: 2,
        timeoutMs: 180_000,
        notice: () => undefined,
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([
        expect.objectContaining({
          code: 'MODEL_UNAVAILABLE',
          message: expect.stringContaining('GitHub Copilot does not serve claude-haiku-4.5 to this account'),
        }),
      ]);
    } finally {
      project.cleanup();
    }
  }, 60_000);
});
