/**
 * The runner's own screenshots under each `screenshot` mode, through the real
 * runner over the fake engine: a frame after every passed top-level step for
 * `every-step`, none for the default, no failure frame for `off`, and no
 * frame at all once a secret was filled.
 */

import { describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

function fakeConfig(fake: FakeEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
    actionTimeout: 300,
    credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
    ...extra,
  } as E2EConfig;
}

function reported(outcome: RunOutcome, title: string) {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title);
  if (result === undefined) throw new Error(`no reported result titled ${title}`);
  return result;
}

/** The screenshot artifacts a step owns, as the report links them. */
function stepScreenshots(attempt: RunOutcome['report']['run']['results'][number]['attempts'][number], stepIndex: number) {
  const step = attempt.steps[stepIndex]!;
  return attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && step.artifacts.includes(artifact.id));
}

const SUITE = `import { test, credentials, expect } from 'e2e';

test('opens and taps', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});

test('fills a secret, then taps', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await screen.getByRole('button', { name: 'Submit' }).tap();
});

test('fails on a wrong count', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 200 });
});
`;

describe('screenshot mode', () => {
  it(
    'every-step attaches one frame to each passed top-level step, and none after a secret fill',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/shots.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { screenshot: 'every-step' }) },
      );
      try {
        assertValidReport(outcome.report);
        const passed = reported(outcome, 'opens and taps').attempts.at(-1)!;
        expect(passed.steps.map((step) => step.api)).toEqual(['app.open', 'locator.tap']);
        for (const index of [0, 1]) {
          const shots = stepScreenshots(passed, index);
          expect(shots).toHaveLength(1);
          expect(shots[0]!.producer).toEqual({ kind: 'step', stepId: passed.steps[index]!.id });
        }

        const secret = reported(outcome, 'fills a secret, then taps').attempts.at(-1)!;
        expect(stepScreenshots(secret, 0)).toHaveLength(1);
        for (const index of [1, 2]) {
          expect(stepScreenshots(secret, index)).toEqual([]);
          expect(secret.steps[index]!.events).toContainEqual(expect.objectContaining({ kind: 'policy', name: 'step.screenshot', code: 'PIXEL_TAINTED' }));
        }

        const failed = reported(outcome, 'fails on a wrong count').attempts.at(-1)!;
        expect(failed.status).toBe('failed');
        expect(stepScreenshots(failed, 0)).toHaveLength(1);
        // The failing step keeps the failure frame instead of a step frame of its own.
        expect(stepScreenshots(failed, 1)).toEqual([]);
        expect(failed.failure?.screenshot).toBeDefined();
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'takes no step frames by default, and no failure frame with off',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/shots.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake) },
      );
      try {
        const passed = reported(outcome, 'opens and taps').attempts.at(-1)!;
        expect(passed.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toEqual([]);
        expect(reported(outcome, 'fails on a wrong count').attempts.at(-1)!.failure?.screenshot).toBeDefined();
      } finally {
        project.cleanup();
      }

      const off = createFakeEngine({ artifacts: true });
      const second = await runProject(
        { 'tests/shots.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(off, { screenshot: 'off' }) },
      );
      try {
        const failed = reported(second.outcome, 'fails on a wrong count').attempts.at(-1)!;
        expect(failed.failure?.screenshot).toBeUndefined();
        expect(failed.failure?.screen).toBeDefined();
      } finally {
        second.project.cleanup();
      }
    },
    60_000,
  );

  it(
    'asks nothing of an engine that cannot screenshot, so its steps carry no failed captures',
    async () => {
      const fake = createFakeEngine({});
      const { outcome, project } = await runProject(
        { 'tests/shots.e2e.ts': SUITE },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { screenshot: 'every-step' }) },
      );
      try {
        const passed = reported(outcome, 'opens and taps').attempts.at(-1)!;
        expect(passed.status).toBe('passed');
        expect(passed.steps.flatMap((step) => step.events.filter((event) => event.name === 'step.screenshot'))).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
