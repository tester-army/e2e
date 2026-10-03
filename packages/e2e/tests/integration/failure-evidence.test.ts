/**
 * What a failed attempt leaves behind beyond its message: the screen at
 * failure as a `log` artifact, a masked screenshot when the run keeps
 * screenshots, the location, the nodes closest to what a failed locator
 * asked for, the failure's structured details, and the test line each step
 * and the error resolve to. Driven through the real runner over the fake
 * engine, so the capture is tested where it runs: in the attempt's own
 * teardown, before the session closes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OperationContext, SemanticNode } from '../../src/engine/contract.ts';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

function fakeConfig(fake: FakeEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
    actionTimeout: 300,
    ...extra,
  } as E2EConfig;
}

/** The result as the report carries it, by title. */
function reported(outcome: RunOutcome, title: string) {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title);
  if (result === undefined) throw new Error(`no reported result titled ${title}`);
  return result;
}

const MISSING_LOCATOR_TEST = `import { test } from 'e2e';

test('taps a button that is not there', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});
`;

const WAIT_FOR_NEAR_MISS_TEST = `import { test } from 'e2e';

test('waits for a button named a little differently', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submits the order' }).waitFor({ timeout: 300 });
});
`;

const TEARDOWN_TEST = `import { test } from 'e2e';

test.afterEach(async ({ app }) => {
  await app.open('/after');
});

test('fails, then tears down', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});
`;

const WRONG_EXPECTATION_TEST = `import { test, expect } from 'e2e';

test('expects the wrong count', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 200 });
});
`;

/** Two ids that once shared an artifact directory: the space in the first title percent-encodes to `%20`, and both `%20` and `_20` sanitize to `_20`. */
const COLLIDING_TITLES_TEST = `import { test } from 'e2e';

test('artifact a', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});

test('artifact_20a', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});
`;

describe('failure evidence', () => {
  it(
    'lists the closest nodes for a waitFor that timed out, a word one edit away included and a short word never stretched',
    async () => {
      const tree: SemanticNode = {
        ref: { id: 'root', revision: '' },
        role: 'root',
        children: [
          { ref: { id: 'submit', revision: '' }, role: 'button', name: 'Submit', states: { hidden: false } },
          { ref: { id: 'themes', revision: '' }, role: 'button', name: 'Themes', states: { hidden: false } },
          { ref: { id: 'cancel', revision: '' }, role: 'button', name: 'Cancel', states: { hidden: false } },
        ],
      };
      const fake = createFakeEngine({ artifacts: true, locate: () => [], tree });
      const { outcome, project } = await runProject(
        { 'tests/wait.e2e.ts': WAIT_FOR_NEAR_MISS_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake) },
      );
      try {
        assertValidReport(outcome.report);
        const attempt = reported(outcome, 'waits for a button named a little differently').attempts.at(-1)!;
        expect(attempt.error).toMatchObject({
          code: 'LOCATOR_NOT_FOUND',
          details: { locator: 'getByRole("button", name: "Submits the order")', role: 'button', name: 'Submits the order' },
        });
        expect(attempt.error?.details?.waitedMs).toBeGreaterThanOrEqual(300);
        expect(attempt.failure?.candidates).toEqual([expect.stringContaining('button "Submit"')]);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'keeps the screen, a screenshot, the location, and the closest nodes when a locator matched nothing, and the locator facts on the error',
    async () => {
      const fake = createFakeEngine({ artifacts: true, locate: () => [] });
      const { outcome, project } = await runProject(
        { 'tests/missing.e2e.ts': MISSING_LOCATOR_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake) },
      );
      try {
        assertValidReport(outcome.report);
        // The report, not the raw records: sources resolve when the report is built.
        const result = reported(outcome, 'taps a button that is not there');
        expect(result.status).toBe('failed');
        const attempt = result.attempts.at(-1)!;
        expect(attempt.error).toMatchObject({
          code: 'LOCATOR_NOT_FOUND',
          details: { locator: 'getByRole("button", name: "Submit now")', role: 'button', name: 'Submit now' },
        });
        // What the locator actually waited: the action timeout, give or take a poll.
        expect(attempt.error?.details?.waitedMs).toBeGreaterThanOrEqual(300);
        expect(attempt.error?.details?.waitedMs).toBeLessThan(3_000);
        // The error and the failing step both resolve to the line in the test file that made the call.
        expect(attempt.error?.source?.file).toBe('tests/missing.e2e.ts');
        const failedStep = attempt.steps.find((step) => step.status !== 'passed')!;
        expect(failedStep.api).toBe('locator.tap');
        expect(failedStep.source.file).toBe('tests/missing.e2e.ts');
        expect(attempt.steps[0]?.source.file).toBe('tests/missing.e2e.ts');

        const failure = attempt.failure!;
        expect(failure.url).toContain('127.0.0.1:4599');
        // The Submit button is the button on screen; the locator asked for one named differently.
        expect(failure.candidates).toEqual([expect.stringContaining('button "Submit"')]);
        const screen = attempt.artifacts.find((artifact) => artifact.id === failure.screen)!;
        expect(screen.kind).toBe('log');
        expect(screen.producer).toEqual({ kind: 'attempt' });
        const screenFile = path.join(project.dir, '.e2e', 'artifacts', screen.path!);
        expect(existsSync(screenFile)).toBe(true);
        const text = readFileSync(screenFile, 'utf8');
        expect(text.startsWith('# Screen at failure\nurl: ')).toBe(true);
        expect(text).toContain('button "Submit"');
        const shot = attempt.artifacts.find((artifact) => artifact.id === failure.screenshot)!;
        expect(shot.kind).toBe('screenshot');
        expect(fake.operations.some((operation) => operation.method === 'artifacts.screenshot(failure)')).toBe(true);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'looks at the screen before teardown runs, so an afterEach that navigates away cannot replace the evidence',
    async () => {
      const fake = createFakeEngine({ artifacts: true, locate: () => [] });
      const { outcome, project } = await runProject({ 'tests/teardown.e2e.ts': TEARDOWN_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        expect(reported(outcome, 'fails, then tears down').attempts.at(-1)?.failure?.screen).toBeDefined();
        const methods = fake.operations.map((operation) => operation.method);
        const evidenceObserve = methods.indexOf('observe');
        const teardownNavigate = methods.findIndex((method) => method.startsWith('session.open(') && method.includes('/after'));
        expect(evidenceObserve).toBeGreaterThan(-1);
        expect(teardownNavigate).toBeGreaterThan(evidenceObserve);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'looks once when the look sees nothing, instead of spending the evidence budget again before the session closes',
    async () => {
      const fake = createFakeEngine({
        locate: () => [],
        observe: () => {
          throw new Error('the page stopped answering');
        },
      });
      const { outcome, project } = await runProject({ 'tests/missing.e2e.ts': MISSING_LOCATOR_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        const attempt = reported(outcome, 'taps a button that is not there').attempts.at(-1)!;
        expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
        expect(attempt.failure).toBeUndefined();
        expect(fake.operations.filter((operation) => operation.method === 'observe')).toHaveLength(1);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'records what an assertion expected and observed as details, and always captures the screen and a screenshot',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/count.e2e.ts': WRONG_EXPECTATION_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake) },
      );
      try {
        assertValidReport(outcome.report);
        const attempt = reported(outcome, 'expects the wrong count').attempts.at(-1)!;
        expect(attempt.error).toMatchObject({
          code: 'ASSERTION_FAILED',
          details: { locator: 'getByRole("button")', expected: 'count 2', matches: 1 },
        });
        expect(attempt.error?.details?.observed).toBeDefined();
        expect(attempt.failure?.screen).toBeDefined();
        expect(attempt.failure?.screenshot).toBeDefined();
        expect(attempt.failure?.candidates).toBeUndefined();
        expect(fake.operations.some((operation) => operation.method.startsWith('artifacts.screenshot('))).toBe(true);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it.each([
    [
      'honors its cancellation',
      (operation: OperationContext) =>
        new Promise<void>((_, reject) => operation.signal.addEventListener('abort', () => reject(new Error('observe cancelled')))),
    ],
    ['ignores its cancellation', () => new Promise<void>(() => undefined)],
  ])(
    'looks once and gives up at the evidence budget when the screen never answers and the engine %s, keeping the original failure',
    async (_, observe) => {
      const fake = createFakeEngine({ artifacts: true, locate: () => [], observe });
      const { outcome, project } = await runProject({ 'tests/teardown.e2e.ts': TEARDOWN_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        assertValidReport(outcome.report);
        const attempt = reported(outcome, 'fails, then tears down').attempts.at(-1)!;
        expect(attempt.error?.code).toBe('LOCATOR_NOT_FOUND');
        expect(attempt.failure).toBeUndefined();
        expect(fake.operations.filter((operation) => operation.method === 'observe')).toHaveLength(1);
        // The 5 s budget once, not once per capture point.
        expect(attempt.durationMs).toBeLessThan(8_000);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );

  it(
    'keeps the evidence of two tests whose ids sanitize to the same directory name apart, each report digest matching its file',
    async () => {
      const fake = createFakeEngine({ artifacts: true, locate: () => [] });
      const { outcome, project } = await runProject({ 'tests/collide.e2e.ts': COLLIDING_TITLES_TEST }, { appUrl: FAKE_APP_URL, config: fakeConfig(fake) });
      try {
        assertValidReport(outcome.report);
        const evidence = ['artifact a', 'artifact_20a'].map((title) => {
          const attempt = reported(outcome, title).attempts.at(-1)!;
          expect(attempt.status).toBe('failed');
          const screen = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screen)!;
          const shot = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screenshot)!;
          return { screen, shot };
        });
        const [first, second] = evidence as [(typeof evidence)[number], (typeof evidence)[number]];
        expect(first.screen.path).not.toBe(second.screen.path);
        expect(first.shot.path).not.toBe(second.shot.path);
        for (const artifact of [first.screen, first.shot, second.screen, second.shot]) {
          const file = path.join(project.dir, '.e2e', 'artifacts', artifact.path!);
          expect(existsSync(file)).toBe(true);
          expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(artifact.sha256);
        }
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );
});
