/**
 * `artifacts.trace.record: 'retries'`: a first attempt runs without a trace,
 * and every retry records one, for a test and for a serial group's shared
 * session alike. Driven through the runner on the real web engine, since
 * the fake engine records no trace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('passes first time', async ({ app }) => {
  await app.open();
});

test('always fails', async ({ app }) => {
  await app.open();
  throw new Error('nope');
});

test.describe('wizard', { serial: true }, () => {
  test('step 1', async ({ app }) => {
    await app.open();
  });

  test('step 2 fails', async () => {
    throw new Error('nope');
  });
});
`;

/** How many trace artifacts each attempt of a result carries, by attempt index. */
function tracesPerAttempt(outcome: RunOutcome, title: string): number[] {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title)!;
  return result.attempts.map((attempt) => attempt.artifacts.filter((artifact) => artifact.kind === 'trace').length);
}

describe('artifacts.trace.record', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'records a trace on retries only, for a test and a serial group',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/suite.e2e.ts': SUITE },
        {
          appUrl: app.url,
          config: { retries: 1, cache: 'off', artifacts: { kinds: ['trace'], trace: { record: 'retries' } } },
        },
      );
      try {
        expect(tracesPerAttempt(outcome, 'passes first time')).toEqual([0]);
        expect(tracesPerAttempt(outcome, 'always fails')).toEqual([0, 1]);
        const group = outcome.report.run.serialGroups[0]!;
        expect(group.attempts.map((attempt) => attempt.artifacts.filter((artifact) => artifact.kind === 'trace').length)).toEqual([0, 1]);
        // A named kind is required: an attempt that never started a trace must not stop one.
        const attempts = [...outcome.report.run.results.flatMap((result) => result.attempts), ...group.attempts];
        expect(attempts.map((attempt) => [attempt.cleanup, attempt.secondaryErrors])).toEqual(
          attempts.map(() => ['complete', []]),
        );
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'records every attempt by default',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/suite.e2e.ts': SUITE },
        { appUrl: app.url, config: { retries: 1, cache: 'off', artifacts: { kinds: ['trace'] } } },
      );
      try {
        expect(tracesPerAttempt(outcome, 'passes first time')).toEqual([1]);
        expect(tracesPerAttempt(outcome, 'always fails')).toEqual([1, 1]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
