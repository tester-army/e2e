/**
 * What a failed attempt leaves behind beyond its message: the screen at
 * failure as a `log` artifact, a masked screenshot when the run keeps
 * screenshots, the location, the nodes closest to what a failed locator
 * asked for, the failure's structured details, and the test line each step
 * and the error resolve to. Driven through the real runner over the fake
 * engine, so the capture is tested where it runs: in the attempt's own
 * teardown, before the session closes.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

function fakeConfig(fake: FakeEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    specVersion: '0.1',
    targets: [{ name: 'fake', platform: 'web', engine: fake.engine }],
    artifacts: ['screenshot'],
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

const WRONG_EXPECTATION_TEST = `import { test, expect } from 'e2e';

test('expects the wrong count', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button')).toHaveCount(2, { timeout: 200 });
});
`;

describe('failure evidence', () => {
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
          details: { locator: 'getByRole("button", name: "Submit now")', role: 'button', name: 'Submit now', waitedMs: 300 },
        });
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
    'records what an assertion expected and observed as details, and captures the screen without a screenshot when the run keeps none',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/count.e2e.ts': WRONG_EXPECTATION_TEST },
        { appUrl: FAKE_APP_URL, config: fakeConfig(fake, { artifacts: [] }) },
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
        expect(attempt.failure?.screenshot).toBeUndefined();
        expect(attempt.failure?.candidates).toBeUndefined();
        expect(fake.operations.some((operation) => operation.method.startsWith('artifacts.screenshot('))).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    30_000,
  );
});
