import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('test.step', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'groups the steps its body calls under one named step in the report, and fails at the call inside it',
    async () => {
      const file = `import { expect, test } from 'e2e';

test('groups calls', async ({ app, screen }) => {
  await app.open();
  const items = await test.step('read the landing page', async () => {
    await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
    return screen.getByTestId('item').count();
  });
  expect(items).toBe(3);
  await test.step('count up', async () => {
    await test.step('tap twice', async () => {
      await screen.getByRole('button', { name: 'Increment' }).tap();
      await screen.getByRole('button', { name: 'Increment' }).tap();
    });
    await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
  });
});

test('fails inside a step', async ({ app, screen }) => {
  await app.open();
  await test.step('look for a ghost', async () => {
    await expect(screen.getByRole('button', { name: 'Ghost' })).toBeVisible({ timeout: 300 });
  });
});

test('forgets an await inside a step', async ({ app, screen }) => {
  await app.open();
  await test.step('careless', async () => {
    void screen.getByRole('button', { name: 'Increment' }).tap();
  });
});
`;
      const { outcome, project } = await runProject({ 'tests/steps.e2e.ts': file }, { appUrl: app.url });
      assertValidReport(outcome.report);

      const grouped = resultByTitle(outcome, 'groups calls');
      expect(grouped.status).toBe('passed');
      const steps = grouped.attempts[0]!.steps;
      const byIndex = (index: number) => steps[index]!;
      // A read (`count()`) is not a step; the calls that act or check are.
      expect(steps.map((step) => [step.kind, step.api, step.label])).toEqual([
        ['app', 'app.open', '/'],
        ['test', 'test.step', 'read the landing page'],
        ['assertion', 'expect.toBeVisible', 'getByRole("heading", name: "Home")'],
        ['test', 'test.step', 'count up'],
        ['test', 'test.step', 'tap twice'],
        ['locator', 'locator.tap', 'getByRole("button", name: "Increment")'],
        ['locator', 'locator.tap', 'getByRole("button", name: "Increment")'],
        ['assertion', 'expect.toHaveText', 'getByRole("status", name: "Counter")'],
      ]);
      expect(steps.map((step) => step.parent)).toEqual([
        undefined,
        undefined,
        byIndex(1).id,
        undefined,
        byIndex(3).id,
        byIndex(4).id,
        byIndex(4).id,
        byIndex(3).id,
      ]);
      expect(steps.every((step) => step.status === 'passed')).toBe(true);
      expect(byIndex(1).source?.file).toBe('tests/steps.e2e.ts');
      expect(byIndex(1).durationMs).toBeGreaterThanOrEqual(byIndex(2).durationMs);

      const failing = resultByTitle(outcome, 'fails inside a step');
      expect(failing.status).toBe('failed');
      const failingSteps = failing.attempts[0]!.steps;
      expect(failingSteps.map((step) => [step.api, step.status])).toEqual([
        ['app.open', 'passed'],
        ['test.step', 'failed'],
        ['expect.toBeVisible', 'failed'],
      ]);
      expect(failingSteps[1]!.error?.code).toBe(failingSteps[2]!.error?.code);
      expect(failing.attempts[0]!.error?.code).toBe(failingSteps[2]!.error?.code);

      const careless = resultByTitle(outcome, 'forgets an await inside a step');
      expect(careless.status).toBe('failed');
      expect(careless.attempts[0]!.error).toMatchObject({
        code: 'STEP_NOT_AWAITED',
        message: expect.stringContaining('test.step "careless" returned before locator.tap'),
      });
      expect(careless.attempts[0]!.steps.map((step) => [step.api, step.status, step.error?.code])).toEqual([
        ['app.open', 'passed', undefined],
        ['test.step', 'failed', 'STEP_NOT_AWAITED'],
        ['locator.tap', 'failed', 'STEP_NOT_AWAITED'],
      ]);
      project.cleanup();
    },
    120_000,
  );
});
