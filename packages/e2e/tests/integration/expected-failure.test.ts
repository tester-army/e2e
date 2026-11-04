import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { renderJunitReport } from '../../src/report/junit.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('test.fail', () => {
  it(
    'passes a marked test that fails, fails one that passes, and keeps the reason and error in the report',
    async () => {
      const file = `import { expect, test } from 'e2e';

test.fail('registered fails', async ({ app }) => {
  await app.open();
  expect(1).toBe(2);
});

test('option fails', { fail: 'known gap' }, async () => {
  throw new Error('the gap');
});

test('runtime fails', async () => {
  test.fail(true, 'gap at runtime');
  expect('a').toBe('b');
});

test('condition false runs as normal', async () => {
  test.fail(false, 'never');
});

test('option passes', { fail: 'gap is fixed' }, async () => {});

test('marked then skipped', { fail: 'gap' }, async () => {
  test.skip(true, 'not here');
});

test('soft failure then skipped', { fail: 'gap' }, async () => {
  expect.soft(1).toBe(2);
  test.skip(true, 'not here either');
});

test('engine failure', { fail: 'engine gap' }, async () => {
  const error = Object.assign(new Error('tap on display: contents failed'), { name: 'EngineError', code: 'ENGINE_FAILURE', retryable: false });
  throw error;
});

test('times out', { fail: 'too slow', timeout: 500 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});
`;
      const { outcome, project } = await runProject({ 'tests/expected.e2e.ts': file }, {});
      assertValidReport(outcome.report);
      const byTitle = (title: string) => outcome.report.run.results.find((result) => result.titlePath.at(-1) === title)!;

      const registered = byTitle('registered fails');
      expect(registered.status).toBe('passed');
      expect(registered.expectedFailure).toEqual({ reason: 'expected to fail' });
      expect(registered.attempts[0]?.error).toBeUndefined();
      expect(registered.attempts[0]?.expectedFailure).toMatchObject({ reason: 'expected to fail', error: { category: 'test', code: 'ASSERTION_FAILED' } });

      expect(byTitle('option fails')).toMatchObject({ status: 'passed', expectedFailure: { reason: 'known gap' } });
      expect(byTitle('option fails').attempts[0]?.expectedFailure?.error).toMatchObject({ code: 'ERROR', message: expect.stringContaining('the gap') });
      expect(byTitle('runtime fails')).toMatchObject({ status: 'passed', expectedFailure: { reason: 'gap at runtime' } });
      expect(byTitle('times out')).toMatchObject({ status: 'passed', expectedFailure: { reason: 'too slow' } });
      expect(byTitle('times out').attempts[0]?.expectedFailure?.error?.code).toBe('TEST_TIMEOUT');

      const normal = byTitle('condition false runs as normal');
      expect(normal.status).toBe('passed');
      expect(normal.expectedFailure).toBeUndefined();
      expect(normal.attempts[0]?.expectedFailure).toBeUndefined();

      const unexpected = byTitle('option passes');
      expect(unexpected.status).toBe('failed');
      expect(unexpected.expectedFailure).toEqual({ reason: 'gap is fixed' });
      expect(unexpected.attempts[0]?.error).toMatchObject({ category: 'test', code: 'UNEXPECTED_PASS', message: expect.stringContaining('"gap is fixed"') });

      const skipped = byTitle('marked then skipped');
      expect(skipped.status).toBe('skipped');
      expect(skipped.expectedFailure).toBeUndefined();
      // A skip wins beside a failure too: the attempt fails as an unmarked one would.
      const softSkipped = byTitle('soft failure then skipped');
      expect(softSkipped.status).toBe('failed');
      expect(softSkipped.attempts[0]?.expectedFailure).toBeUndefined();

      // An engine failure is not a test failure: the mark records but does not cover it.
      const engine = byTitle('engine failure');
      expect(engine.status).toBe('failed');
      expect(engine.attempts[0]?.error).toMatchObject({ category: 'infrastructure', code: 'ENGINE_FAILURE' });
      expect(engine.attempts[0]?.expectedFailure).toEqual({ reason: 'engine gap' });

      expect(outcome.report.run.summary).toMatchObject({ passed: 5, failed: 3, skipped: 1 });
      expect(outcome.exitCode).toBe(3);

      const junit = renderJunitReport(outcome.report);
      expect(junit).toContain('failed as expected: known gap');
      expect(junit).toContain('type="UNEXPECTED_PASS"');
      project.cleanup();
    },
    120_000,
  );

  it(
    'takes a mark from a beforeEach hook and refuses one from an afterEach hook',
    async () => {
      const file = `import { afterEach, beforeEach, describe, expect, test } from 'e2e';

describe('marked early', () => {
  beforeEach(() => {
    test.fail('marked in beforeEach');
  });
  test('fails after a beforeEach mark', async () => {
    expect(1).toBe(2);
  });
});

describe('marked late', () => {
  afterEach(() => {
    test.fail('too late');
  });
  test('fails before an afterEach mark', async () => {
    expect(1).toBe(2);
  });
});
`;
      const { outcome, project } = await runProject({ 'tests/hooks.e2e.ts': file }, {});
      assertValidReport(outcome.report);
      const byTitle = (title: string) => outcome.report.run.results.find((result) => result.titlePath.at(-1) === title)!;
      expect(byTitle('fails after a beforeEach mark')).toMatchObject({ status: 'passed', expectedFailure: { reason: 'marked in beforeEach' } });
      const late = byTitle('fails before an afterEach mark');
      expect(late.status).toBe('failed');
      expect(late.attempts[0]?.expectedFailure).toBeUndefined();
      expect(late.attempts[0]?.secondaryErrors).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('cannot mark a test from an afterEach hook') })]),
      );
      project.cleanup();
    },
    120_000,
  );

  it(
    'does not retry an expected failure, retries an unexpected pass, and a failure before the mark retries as usual',
    async () => {
      const file = `import { expect, test } from 'e2e';

const counter = globalThis as { failRuns?: number; passRuns?: number };

test('expected failure', { fail: 'gap', retries: 2 }, async () => {
  expect(1).toBe(2);
});

test('unexpected pass', { fail: 'gap', retries: 2 }, async () => {});

test('passes once, then fails as expected', { fail: 'gap', retries: 2 }, async () => {
  counter.passRuns = (counter.passRuns ?? 0) + 1;
  if (counter.passRuns > 1) expect(1).toBe(2);
});

test('fails before the mark', { retries: 2 }, async () => {
  counter.failRuns = (counter.failRuns ?? 0) + 1;
  if (counter.failRuns === 1) throw new Error('first attempt fails unmarked');
  test.fail('gap from the second attempt');
  expect(1).toBe(2);
});
`;
      const { outcome, project } = await runProject({ 'tests/retries.e2e.ts': file }, {});
      expect(resultByTitle(outcome, 'expected failure')).toMatchObject({ status: 'passed' });
      expect(resultByTitle(outcome, 'expected failure').attempts).toHaveLength(1);
      expect(resultByTitle(outcome, 'unexpected pass')).toMatchObject({ status: 'failed' });
      expect(resultByTitle(outcome, 'unexpected pass').attempts.map((attempt) => attempt.error?.code)).toEqual(['UNEXPECTED_PASS', 'UNEXPECTED_PASS', 'UNEXPECTED_PASS']);
      const flaky = resultByTitle(outcome, 'passes once, then fails as expected');
      expect(flaky.status).toBe('flaky');
      expect(flaky.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
      const late = resultByTitle(outcome, 'fails before the mark');
      expect(late.status).toBe('flaky');
      expect(late.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
      expect(late.attempts[1]?.expectedFailure?.reason).toBe('gap from the second attempt');
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'rejects test.fail outside a body, in a setup test, and in a serial group',
    async () => {
      const outside = await runProject(
        { 'tests/outside.e2e.ts': `import { test } from 'e2e';\n\ntest.fail(true, 'not here');\ntest('never registered', async () => {});\n` },
        {},
      );
      expect(outside.outcome.exitCode).toBe(2);
      expect(outside.outcome.report.run.errors.map((error) => error.code)).toEqual(['COLLECTION_ERROR']);
      expect(outside.outcome.report.run.errors[0]?.message).toMatch(/must be called inside a test body/);
      outside.project.cleanup();

      const file = `import { test } from 'e2e';

test.setup('sign in', { sessions: ['admin'] }, async ({ session }) => {
  test.fail(true, 'a setup may not fail on purpose');
  await session.save('admin');
});

test.describe('wizard', { serial: true }, () => {
  test('step 1', async () => {
    test.fail('a member may not fail on purpose');
  });
});

test('consumer', { session: 'admin' }, async () => {});
`;
      const { outcome, project } = await runProject({ 'tests/refused.e2e.ts': file }, {});
      expect(resultByTitle(outcome, 'sign in').attempts[0]?.error?.code).toBe('INVALID_ARGUMENT');
      const member = outcome.report.run.serialGroups[0]?.attempts[0]?.members[0];
      expect(member?.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('serial group member') });
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );
});
