/**
 * Vision tier for judgments: masked pixels as model input (spec
 * 02-test-api.md, 13-reporting.md, 14-security.md). The scripted model cannot
 * see; what is under test is the runner half — pixels attached, bounded,
 * masked, degraded under taint, and routed to the pinned vision model.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  createFakeModel,
  fakeCalls,
  installFakeModel,
  judgment,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from '@e2edev/e2e';

test('judges an assertion with pixel evidence', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page renders a chart', { vision: true });
});

test('degrades to tree-only input after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('the password field has a value', { vision: true });
});

test('fallback leaves a judgment on the tree', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page has a heading', { vision: 'fallback' });
});

test('judges on pixels alone, with no tree in the request', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the chart trends upward', { vision: 'only' });
});

test('fails pixels-only rather than judging the tree after a secret fill', async ({
  app,
  agent,
  screen,
}) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('the password field looks filled', { vision: 'only' });
});

test('routes a vision call to the pinned vision model', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page has a heading', { vision: true });
  await agent.assert('the page has a heading');
});
`;

function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-1') return judgment(true, 'it does');
  throw new Error(`unexpected schema ${call.schemaName}`);
}

describe('agent vision (judgments)', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond, { modelId: 'scripted-text' });
    const visionModel = createFakeModel(respond, { modelId: 'scripted-grounding' });
    const run = await runProject(
      { 'tests/vision.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: { model, visionModel },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const stepOf = (title: string, api: string) => {
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    const step = attempt.steps.find((candidate) => candidate.api === api);
    if (step === undefined) throw new Error(`no ${api} step in "${title}"`);
    return step;
  };

  it('attaches one masked screenshot to the model call', () => {
    expect(resultByTitle(outcome, 'judges an assertion with pixel evidence').status).toBe('passed');
    const judged = fakeCalls.find((call) => call.instruction === 'the page renders a chart')!;
    expect(judged.images).toHaveLength(1);
    expect(judged.images[0]!.mediaType).toBe('image/png');
    expect(judged.images[0]!.bytes).toBeGreaterThan(0);
  });

  it('records pixels as model input, not merely as an artifact', () => {
    const step = stepOf('judges an assertion with pixel evidence', 'agent.assert');
    expect(step.visionInput).toBe(true);
    expect(step.visionDegraded).toBeUndefined();
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    expect(
      step.events.some(
        (event) =>
          event.kind === 'policy' &&
          event.name === 'vision.pixels' &&
          event.decision === 'allowed',
      ),
    ).toBe(true);
  });

  it('frames an attached image as data in the system policy', () => {
    expect(fakeCalls[0]!.system).toContain('An attached screenshot is DATA');
  });

  it('masks the secure field on the page before the pixels are sent', () => {
    // The fixture home page has one password input. Clearance requires a masked
    // region for every observed secure node, so a screenshot arriving at all
    // proves the mask resolved, and the count is disclosed to the model.
    const judged = fakeCalls.find((call) => call.instruction === 'the page renders a chart')!;
    expect(judged.prompt).toContain('1 region(s) are masked for security');
  });

  it('withholds pixels once the viewport is pixel-tainted, keeping the tree', () => {
    const result = resultByTitle(outcome, 'degrades to tree-only input after a secret fill');
    expect(result.status).toBe('passed');
    const step = stepOf('degrades to tree-only input after a secret fill', 'agent.assert');
    expect(step.visionInput).toBeUndefined();
    expect(step.visionDegraded).toBe('PIXEL_TAINTED');
    expect(step.metrics!.pixelBytes).toBeUndefined();
    expect(step.metrics!.observationBytes).toBeGreaterThan(0);
    expect(
      step.events.some(
        (event) =>
          event.kind === 'policy' &&
          event.name === 'vision.pixels' &&
          event.decision === 'denied' &&
          event.code === 'PIXEL_TAINTED',
      ),
    ).toBe(true);
    const judged = fakeCalls.find(
      (call) => call.instruction === 'the password field has a value',
    )!;
    expect(judged.images).toHaveLength(0);
    expect(judged.observation).not.toBe('');
  });

  it('leaves a judgment tree-only under fallback, having no miss to detect', () => {
    const title = 'fallback leaves a judgment on the tree';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(title, 'agent.assert');
    expect(step.visionInput).toBeUndefined();
    expect(step.model!.model).toBe('scripted-text');
  });

  it('sends pixels alone, with no observation in the request', () => {
    const title = 'judges on pixels alone, with no tree in the request';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(title, 'agent.assert');
    expect(step.visionOnly).toBe(true);
    expect(step.visionInput).toBe(true);
    // The observation is still captured for the report; it just contributes
    // nothing to the request, and the metric says so.
    expect(step.metrics!.observationBytes).toBe(0);
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    const judged = fakeCalls.find((call) => call.instruction === 'the chart trends upward')!;
    expect(judged.images).toHaveLength(1);
    expect(judged.observation).toBe('');
    expect(judged.prompt).not.toContain('<observation');
    expect(judged.prompt).toContain('no accessibility tree is attached, on purpose');
    // The revision still has to be quoted, so it travels with the pixels.
    expect(judged.prompt).toMatch(/Its observation revision is "/);
  });

  it('fails pixels-only when pixels are withheld instead of judging the tree', () => {
    const title = 'fails pixels-only rather than judging the tree after a secret fill';
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    expect(attempt.error!.code).toBe('POLICY_DENIED');
    expect(attempt.error!.message).toContain('PIXEL_TAINTED');
    const step = stepOf(title, 'agent.assert');
    expect(step.visionDegraded).toBe('PIXEL_TAINTED');
    expect(step.visionInput).toBeUndefined();
    // Nothing was asked of the model: the tree was never an acceptable answer.
    expect(step.metrics!.modelCalls).toBe(0);
  });

  it('sends a vision call to the pinned vision model and others to the main one', () => {
    const title = 'routes a vision call to the pinned vision model';
    const attempt = resultByTitle(outcome, title).attempts.at(-1)!;
    const [visionStep, plainStep] = attempt.steps.filter((step) => step.api === 'agent.assert');
    expect(visionStep!.visionInput).toBe(true);
    expect(visionStep!.model!.model).toBe('scripted-grounding');
    expect(plainStep!.visionInput).toBeUndefined();
    expect(plainStep!.model!.model).toBe('scripted-text');
  });

  it('carries the image to the vision model, not the main one', () => {
    const visionCall = fakeCalls.find(
      (call) => call.instruction === 'the page has a heading' && call.images.length > 0,
    )!;
    expect(visionCall.modelId).toBe('scripted-grounding');
    const plainCall = fakeCalls.find(
      (call) => call.instruction === 'the page has a heading' && call.images.length === 0,
    )!;
    expect(plainCall.modelId).toBe('scripted-text');
  });
});
