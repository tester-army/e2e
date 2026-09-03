import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const KITCHEN_SINK = `import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('deterministic queries and reads', async ({ app, screen }) => {
  await app.open();

  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(screen.getByLabel('Email')).toBeVisible();
  await expect(screen.getByPlaceholder('you@example.test')).toBeVisible();
  await expect(screen.getByText('Item Alpha')).toBeVisible();
  await expect(screen.getByDisplayValue('hello-value')).toBeVisible();
  await expect(screen.getByTestId('items')).toBeVisible();

  await expect(screen.getByTestId('item')).toHaveCount(3);
  await expect(screen.getByTestId('item').first()).toHaveText('Item Alpha');
  await expect(screen.getByTestId('item').last()).toHaveText('Item Gamma');
  await expect(screen.getByTestId('item').nth(1)).toHaveText('Item Beta');
  await expect(
    screen.getByTestId('item').filter({ hasText: 'Beta' }),
  ).toHaveCount(1);

  const count = await screen.getByTestId('item').count();
  expect(count).toBe(3);

  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
  await expect(screen.getByRole('button', { name: 'Increment' })).toBeEnabled();
});

test('actions and state', async ({ app, screen }) => {
  await app.open();

  await screen.getByRole('button', { name: 'Increment' }).tap();
  await screen.getByRole('button', { name: 'Increment' }).click();
  await expect(screen.getByRole('status')).toHaveText('2');

  await screen.getByLabel('Email').fill('user@example.test');
  await expect(screen.getByLabel('Email')).toHaveValue('user@example.test');
  await screen.getByLabel('Email').clear();
  await expect(screen.getByLabel('Email')).toHaveValue('');

  await screen.getByLabel('Notifications').check();
  await expect(screen.getByLabel('Notifications')).toBeChecked();
  await screen.getByLabel('Notifications').uncheck();
  await expect(screen.getByLabel('Notifications')).not.toBeChecked();

  await screen.getByLabel('Plan').selectOption('Pro');
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await screen.getByLabel('Plan').selectOption({ index: 2 });
  await expect(screen.getByLabel('Plan')).toHaveValue('team');

  await screen.getByRole('button', { name: 'Menu' }).tap();
  await expect(screen.getByRole('button', { name: 'Menu' })).toBeExpanded();

  await screen.getByLabel('Email').fill('draft');
  await screen.getByLabel('Email').press('Backspace');
  await expect(screen.getByLabel('Email')).toHaveValue('draf');
});

test('assertions poll until the app settles', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toBeVisible({
    timeout: 3000,
  });
  await screen.getByRole('button', { name: 'Late arrival' }).waitFor({ state: 'visible' });
});

test('ambiguous locators fail immediately', async ({ app, screen }) => {
  await app.open();
  await screen.getByText('Duplicated').tap({ timeout: 2000 });
});

test('missing locators poll until the deadline', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Never exists' }).tap({ timeout: 800 });
});

test('secure fields refuse value reads', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill('hunter2');
  await screen.getByLabel('Password').inputValue();
});

test('acting before open fails with APP_NOT_OPEN', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Increment' }).tap({ timeout: 500 });
});

test('web navigation, urls, and titles', async ({ app, web }) => {
  await app.open();
  await web.goto('/about');
  await expect(web).toHaveURL('/about');
  await expect(web).toHaveTitle('About page');
  await web.back();
  await expect(web).toHaveURL('/');
  await web.forward();
  await expect(web).toHaveURL(/about/);
  const title = await web.title();
  expect(title).toBe('About page');
});

test('routes intercept and fulfill', async ({ app, web, screen }) => {
  await app.open();
  await web.route('**/api/flags', (route) => route.fulfill({ json: { betaBoard: true } }));
  await web.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await web.unroute('**/api/flags');
  await web.reload();
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta off');
});

test('routes are attempt-scoped: registered before the first page, kept across restart and clearState', async ({
  app,
  web,
  screen,
}) => {
  await web.route('**/api/flags', (route) => route.fulfill({ json: { betaBoard: true } }));
  await app.open('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.restart();
  await web.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.clearState();
  await web.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
});

test('waitForResponse observes network traffic', async ({ app, web }) => {
  await app.open();
  const [response] = await Promise.all([
    web.waitForResponse('**/api/flags'),
    web.goto('/flags'),
  ]);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ betaBoard: false });
});

test('evaluate runs trusted code with JSON arguments', async ({ app, web }) => {
  await app.open();
  const result = await web.evaluate((input: { a: number; b: number }) => input.a + input.b, {
    a: 2,
    b: 40,
  });
  expect(result).toBe(42);
  const href = await web.evaluate(() => document.location.pathname);
  expect(href).toBe('/');
});

test('cookies round-trip through policy checks', async ({ app, web }) => {
  await app.open();
  await web.setCookies([{ name: 'flavor', value: 'oatmeal', url: (await web.url()) }]);
  const cookies = await web.cookies();
  const flavor = cookies.find((cookie) => cookie.name === 'flavor');
  expect(flavor?.value).toBe('oatmeal');
});

test('dialogs are handled by registered handlers', async ({ app, web, screen }) => {
  await app.open('/dialog');
  const dispose = await web.onDialog('accept');
  await screen.getByRole('button', { name: 'Ask' }).tap();
  await expect(screen.getByRole('status', { name: 'Answer' })).toHaveText('accepted');
  await dispose();
});

test('frame locators scope queries into iframes', async ({ app, web }) => {
  await app.open('/frame');
  const frame = web.frameLocator('#child');
  await frame.getByRole('button', { name: 'Frame button' }).tap();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('downloads are captured as artifacts', async ({ app, web }) => {
  await app.open('/downloads');
  const download = await web.waitForDownload(() => web.locator('a[download]').tap());
  if (download.suggestedFilename !== 'report.csv') throw new Error(download.suggestedFilename);
  if (!download.path.startsWith('downloads/')) throw new Error(download.path);
});

test('css selectors via web.locator', async ({ app, web }) => {
  await app.open();
  await expect(web.locator('ul[data-testid="items"] li').first()).toHaveText('Item Alpha');
});

test('app lifecycle: restart preserves storage, clearState clears it', async ({ app, screen }) => {
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');

  await app.restart();
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');

  await app.clearState();
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});

test('screenshots land in the artifact directory', async ({ app }) => {
  await app.open();
  const shot = await app.screenshot('home');
  if (!shot.includes('screenshots/')) throw new Error('unexpected screenshot path: ' + shot);
});

test('deep links honor origin policy', async ({ app }) => {
  await app.open();
  await app.deepLink('https://evil.example.com/phish');
});
`;

describe('web platform integration', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/kitchen.e2e.ts': KITCHEN_SINK },
      {
        appUrl: app.url,
        config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 30_000 },
      },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes every deterministic behavior test', () => {
    const shouldPass = [
      'deterministic queries and reads',
      'actions and state',
      'assertions poll until the app settles',
      'web navigation, urls, and titles',
      'routes intercept and fulfill',
      'routes are attempt-scoped: registered before the first page, kept across restart and clearState',
      'waitForResponse observes network traffic',
      'evaluate runs trusted code with JSON arguments',
      'cookies round-trip through policy checks',
      'dialogs are handled by registered handlers',
      'frame locators scope queries into iframes',
      'css selectors via web.locator',
      'downloads are captured as artifacts',
      'app lifecycle: restart preserves storage, clearState clears it',
      'screenshots land in the artifact directory',
    ];
    for (const title of shouldPass) {
      const result = resultByTitle(outcome, title);
      expect(result.status, `${title}: ${JSON.stringify(result.attempts[0]?.error)}`).toBe('passed');
    }
  });

  it('fails ambiguous locators immediately with LOCATOR_AMBIGUOUS', () => {
    const result = resultByTitle(outcome, 'ambiguous locators fail immediately');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_AMBIGUOUS');
  });

  it('fails missing locators with LOCATOR_NOT_FOUND after polling', () => {
    const result = resultByTitle(outcome, 'missing locators poll until the deadline');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_NOT_FOUND');
  });

  it('denies secure value reads with POLICY_DENIED', () => {
    const result = resultByTitle(outcome, 'secure fields refuse value reads');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
  });

  it('fails UI operations before open with APP_NOT_OPEN', () => {
    const result = resultByTitle(outcome, 'acting before open fails with APP_NOT_OPEN');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('APP_NOT_OPEN');
  });

  it('denies navigation outside allowed origins', () => {
    const result = resultByTitle(outcome, 'deep links honor origin policy');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
  });

  it('exits with configuration precedence and writes report.json', () => {
    // POLICY_DENIED failures classify as configuration errors, and exit-code
    // precedence is 130 > 4 > 3 > 2 > 1 > 0 (06-cli.md).
    expect(outcome.exitCode).toBe(2);
    expect(outcome.status).toBe('error');
    expect(outcome.reportPath).toBeDefined();
    expect(existsSync(outcome.reportPath!)).toBe(true);
    const run = outcome.report['run'] as Record<string, unknown>;
    expect(outcome.report['schemaVersion']).toBe('report-1');
    const summary = run['summary'] as Record<string, number>;
    expect(summary['discovered']).toBe(outcome.results.length);
    expect(summary['failed']).toBeGreaterThan(0);
    expect(summary['passed']).toBeGreaterThan(0);
  });

  it('emits a schema-valid report-1 document', () => {
    assertValidReport(outcome.report);
    const written = JSON.parse(
      readFileSync(outcome.reportPath!, 'utf8'),
    ) as Record<string, unknown>;
    assertValidReport(written);
  });

  it('attributes a download to the fixture step that produced it, not the nested tap', () => {
    const result = resultByTitle(outcome, 'downloads are captured as artifacts');
    const attempt = result.attempts[0]!;
    const waitStep = attempt.steps.find((step) => step.api === 'web.waitForDownload');
    expect(waitStep?.artifacts).toHaveLength(1);
    const tapStep = attempt.steps.find((step) => step.api === 'locator.tap');
    expect(tapStep?.artifacts ?? []).toHaveLength(0);
    expect(attempt.artifacts.find((artifact) => artifact.kind === 'download')?.path).toContain('downloads/');
  });

  it('records steps and screenshot artifacts on attempts', () => {
    const result = resultByTitle(outcome, 'screenshots land in the artifact directory');
    const attempt = result.attempts[0]!;
    expect(attempt.steps.length).toBeGreaterThan(1);
    expect(attempt.steps.map((step) => step.api)).toContain('app.screenshot');
    const screenshot = attempt.artifacts.find((artifact) => artifact.kind === 'screenshot');
    expect(screenshot).toBeDefined();
    expect(screenshot!.path).toBeDefined();
    const artifactsRoot = path.join(project.dir, '.e2e', 'artifacts');
    expect(existsSync(path.join(artifactsRoot, screenshot!.path!))).toBe(true);
  });
});
