import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SOFT_SUITE = `import { test, expect } from 'e2e';

test('soft failures let the body run on', async ({ app, screen }) => {
  await app.open();
  expect.soft(1, 'the count').toBe(2);
  await expect.soft(screen.getByRole('button', { name: 'Submit' })).toBeHidden({ timeout: 300 });
  expect.soft('ok').toBe('ok');
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
});

test('a body error stays primary over the soft failures', async ({ app }) => {
  await app.open();
  expect.soft(1).toBe(2);
  throw new Error('the body gave up');
});

test('a timed-out body still settles its soft failures', { timeout: 300 }, async ({ app }) => {
  await app.open();
  expect.soft(1).toBe(2);
  await new Promise(() => {});
});

test.describe('soft in a hook', () => {
  test.afterEach(() => {
    expect.soft(1).toBe(2);
  });

  test('a soft matcher in afterEach throws at once', async ({ app }) => {
    await app.open();
  });
});
`;

describe('expect.soft in a run', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    ({ outcome, project } = await runProject({ 'tests/soft.e2e.ts': SOFT_SUITE }, { config: { reporters: ['markdown'] } }));
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
  });

  it('produces a schema-valid report', () => {
    assertValidReport(outcome.report);
    expect(outcome.exitCode).toBe(1);
  });

  it('runs the body to its end, then fails the attempt with every soft failure in order', () => {
    const result = resultByTitle(outcome, 'soft failures let the body run on');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
    const lines = attempt.error!.message.split('\n');
    expect(lines[0]).toBe('2 soft assertions failed');
    expect(lines[1]).toBe('1. the count: expected 1 to be 2');
    expect(lines[2]).toBe('2. expect.toBeHidden failed');
    expect(lines.filter((line) => line.startsWith('   locator: ') && line.includes('Submit'))).toHaveLength(1);
    expect(attempt.error?.source?.file).toBe('tests/soft.e2e.ts');
    // The failed locator matcher is a recorded step; the hard matcher after it still ran and passed.
    expect(attempt.steps.map((step) => [step.api, step.status])).toEqual([
      ['app.open', 'passed'],
      ['expect.toBeHidden', 'failed'],
      ['expect.toBeVisible', 'passed'],
    ]);
    expect(attempt.steps[1]?.error?.code).toBe('ASSERTION_FAILED');
    expect(attempt.secondaryErrors).toEqual([]);
  });

  it('names no step in the summary, since the error unwound through a value matcher, and points at its line', () => {
    const attempt = resultByTitle(outcome, 'soft failures let the body run on').attempts[0]!;
    const summary = readFileSync(path.join(project.dir, '.e2e', 'summary.md'), 'utf8');
    expect(summary).toContain(`**🔴 soft failures let the body run on**  \n\`tests/soft.e2e.ts:${attempt.error!.source!.line}\`\n\n**ASSERTION_FAILED**\n\n`);
  });

  it('keeps the body error primary and notes the soft failures beside it', () => {
    const result = resultByTitle(outcome, 'a body error stays primary over the soft failures');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors).toHaveLength(1);
    expect(attempt.secondaryErrors[0]).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
    expect(attempt.secondaryErrors[0]!.message).toBe('1 soft assertion failed\n1. expected 1 to be 2');
  });

  it('notes the soft failures of a body that timed out beside the timeout', () => {
    const result = resultByTitle(outcome, 'a timed-out body still settles its soft failures');
    expect(result.status).toBe('timed-out');
    const attempt = result.attempts[0]!;
    expect(attempt.error?.code).toBe('TEST_TIMEOUT');
    expect(attempt.secondaryErrors.map((error) => [error.code, error.message])).toEqual([
      ['ASSERTION_FAILED', '1 soft assertion failed\n1. expected 1 to be 2'],
    ]);
  });

  it('throws at once from an afterEach hook, where nothing collects soft failures', () => {
    const result = resultByTitle(outcome, 'a soft matcher in afterEach throws at once');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'afterEach', message: 'expected 1 to be 2' });
  });
});
