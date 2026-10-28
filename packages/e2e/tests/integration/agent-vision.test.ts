/**
 * Vision tier for judgments: masked pixels as model input. The scripted model cannot
 * see; what is under test is the runner half — pixels attached, bounded,
 * masked, kept after a secret fill, and routed to the pinned vision model.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  fakeCalls,
  installFakeModel,
  judgment,
  type FakeCall,
} from '../helpers/fake-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from 'e2e';

test('judges an assertion with pixel evidence', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page renders a chart', { vision: true });
});

test('sends masked pixels after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('the password field has a value', { vision: true });
});

test('judges on pixels alone, with no tree in the request', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the chart trends upward', { vision: 'only' });
});

test('judges on pixels alone after a secret fill', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('the password field looks filled', { vision: 'only' });
});
`;

function respond(call: FakeCall): unknown {
  if (call.schemaName === 'agent-judgment-2') return judgment(true, 'it does');
  throw new Error(`unexpected schema ${call.schemaName}`);
}

describe('agent vision (judgments)', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond, { modelId: 'scripted-text' });
    const run = await runProject(
      { 'tests/vision.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: { default: { model } },
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

  it('sends masked pixels after a secret fill, keeping the value out of the text', () => {
    const title = 'sends masked pixels after a secret fill';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(title, 'agent.assert');
    expect(step.visionInput).toBe(true);
    expect(step.visionDegraded).toBeUndefined();
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    const judged = fakeCalls.find((call) => call.instruction === 'the password field has a value')!;
    expect(judged.images).toHaveLength(1);
    expect(judged.prompt).toContain('1 region(s) are masked for security');
    expect(judged.prompt).not.toContain('hunter2-secret');
    expect(judged.observation).not.toContain('hunter2-secret');
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

  it('judges pixels-only after a secret fill', () => {
    const title = 'judges on pixels alone after a secret fill';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(title, 'agent.assert');
    expect(step.visionOnly).toBe(true);
    expect(step.visionInput).toBe(true);
    expect(step.visionDegraded).toBeUndefined();
    const judged = fakeCalls.find((call) => call.instruction === 'the password field looks filled')!;
    expect(judged.images).toHaveLength(1);
    expect(judged.observation).toBe('');
  });
});
