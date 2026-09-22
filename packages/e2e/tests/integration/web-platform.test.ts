import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const KITCHEN_SINK = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('deterministic queries and reads', async ({ app, screen, web }) => {
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

  const items = await screen.getByTestId('item').all();
  const texts: string[] = [];
  for (const item of items) texts.push((await item.textContent()) ?? '');
  expect(texts).toEqual(['Item Alpha', 'Item Beta', 'Item Gamma']);
  expect(await screen.getByTestId('item').allTextContents()).toEqual(texts);
  expect(await screen.getByTestId('missing').all()).toEqual([]);
  await expect(screen.getByTestId('item')).toHaveText(['Item Alpha', /Beta/, 'Item Gamma']);
  await expect(screen.getByTestId('item')).toContainText(['Alpha', 'Beta', 'Gamma']);
  await expect(screen.getByTestId('item')).not.toHaveText(['Item Alpha', 'Item Beta']);

  await expect(screen.getByText('Hidden content')).toBeAttached();
  await expect(screen.getByText('Hidden content')).toBeHidden();
  await expect(screen.getByText('Never rendered')).not.toBeAttached();
  expect(await screen.getByText('Hidden content').isHidden()).toBe(true);
  expect(await screen.getByText('Never rendered').isHidden()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isDisabled()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Increment' }).isDisabled()).toBe(false);

  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
  await expect(screen.getByRole('button', { name: 'Increment' })).toBeEnabled();

  expect(await screen.getByTestId('items').getAttribute('class')).toBeNull();
  expect(await web.locator('#class-card').getAttribute('class')).toBe('card active');
  expect(await screen.getByLabel('Readonly').getAttribute('readonly')).toBe('');
  expect(await web.locator('#fixture-image').getAttribute('src')).toBe('/fixture.png');
});

test('role vocabulary: tabs, menus, progress, toolbars, images', async ({ app, screen }) => {
  await app.open('/roles');

  await expect(screen.getByRole('image', { name: 'Fixture logo' })).toBeVisible();
  await expect(screen.getByRole('img', { name: 'Fixture logo' })).toBeVisible();
  await expect(screen.getByRole('image', { name: 'Sales chart' })).toBeVisible();
  await expect(screen.getByRole('img')).toHaveCount(2);
  await expect(screen.getByRole('image')).toHaveCount(2);

  const tabs = screen.getByRole('tablist', { name: 'Filter' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('All');
  await expect(screen.getByRole('tabpanel', { name: 'All' })).toHaveText('Everything');

  const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
  await toolbar.getByRole('button', { name: 'Bold' }).tap();
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await expect(toolbar.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('12');

  await screen.getByRole('button', { name: 'View' }).tap();
  const menu = screen.getByRole('menu', { name: 'View' });
  await expect(menu.getByRole('menuitem', { name: 'Zoom in' })).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Show grid' })).toBeChecked();

  await expect(screen.getByRole('progressbar', { name: 'Upload' })).toBeVisible();
  await expect(screen.getByRole('group', { name: 'Notifications' }).getByRole('checkbox')).toHaveCount(1);
  await expect(screen.getByRole('group', { name: 'Notifications' })).toHaveAccessibleName('Notifications');
  await expect(screen.getByRole('form', { name: 'Sign in' }).getByRole('textbox')).toHaveCount(1);
  await expect(screen.getByRole('separator')).toHaveCount(1);
  await expect(screen.getByRole('article', { name: 'First post' })).toHaveText('Body');
});

test('actions and state', async ({ app, screen, web }) => {
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
  await screen.getByLabel('Plan').selectOption({ value: 'free' });
  await expect(screen.getByLabel('Plan')).toHaveValue('free');

  await screen.getByRole('button', { name: 'Menu' }).tap();
  await expect(screen.getByRole('button', { name: 'Menu' })).toBeExpanded();

  await screen.getByLabel('Email').fill('draft');
  await screen.getByLabel('Email').press('Backspace');
  await expect(screen.getByLabel('Email')).toHaveValue('draf');

  await expect(screen.getByLabel('Readonly')).toHaveAttribute('readonly');
  await expect(web.locator('#class-card')).toHaveAttribute('class', /active/);
  await expect(screen.getByLabel('Readonly')).not.toHaveAttribute('hidden');

  await screen.getByLabel('Focus target').focus();
  await expect(screen.getByLabel('Focus target')).toBeFocused();
  await expect(screen.getByLabel('Email')).not.toBeFocused();

  await expect(web).toHaveClass(web.locator('#class-card'), 'card active');
  await expect(web).toHaveClass(web.locator('#class-card'), /active/);
  await expect(web).not.toHaveClass(web.locator('#class-card'), 'card inactive');
});

test('class assertions report the observed class on failure', async ({ app, web }) => {
  await app.open();
  await expect(web).toHaveClass(web.locator('#class-card'), 'card inactive', { timeout: 300 });
});

test('assertions poll until the app settles', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toBeVisible({
    timeout: 3000,
  });
  await screen.getByRole('button', { name: 'Late arrival' }).waitFor({ state: 'visible' });
});

test('a negation that begins late in the budget passes past the deadline', async ({ app, screen, web }) => {
  await app.open();
  await web.evaluate(() => {
    setTimeout(() => {
      document.getElementById('class-card')?.remove();
      document.title = 'Renamed';
    }, 1000);
    return 0;
  });
  await Promise.all([
    expect(screen.getByText('Card')).not.toBeAttached({ timeout: 1500 }),
    expect(web).not.toHaveTitle('Fixture Home', { timeout: 1500 }),
  ]);
});

test('not.toHaveURL and not.toHaveClass negations that begin late pass', async ({ app, web }) => {
  await app.open();
  await web.evaluate(() => {
    setTimeout(() => {
      history.pushState({}, '', '/late');
      document.getElementById('class-card')?.classList.replace('active', 'inactive');
    }, 700);
    return 0;
  });
  await Promise.all([
    expect(web).not.toHaveURL('/', { timeout: 1500 }),
    expect(web).not.toHaveClass(web.locator('#class-card'), 'card active', { timeout: 1500 }),
  ]);
});

test('a late not.toHaveTitle fails at the first sample past the deadline', async ({ app, web }) => {
  await app.open();
  await web.evaluate(() => {
    setTimeout(() => { document.title = 'Renamed'; }, 1400);
    return 0;
  });
  await expect(web).not.toHaveTitle('Fixture Home', { timeout: 1000 });
});

test('a late not.toBeVisible fails at the first sample past the deadline', async ({ app, screen, web }) => {
  await app.open();
  await web.evaluate(() => {
    setTimeout(() => document.getElementById('class-card')?.remove(), 1400);
    return 0;
  });
  await expect(screen.getByText('Card')).not.toBeVisible({ timeout: 1000 });
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

test('forbidden URL schemes are refused', async ({ app }) => {
  await app.open();
  await app.open('javascript:alert(1)');
});

test('a step call without await', async ({ app }) => {
  app.open();
});

test('a step call without await before the body throws', async ({ app }) => {
  app.open();
  throw new Error('the body gave up');
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
      'role vocabulary: tabs, menus, progress, toolbars, images',
      'actions and state',
      'assertions poll until the app settles',
      'a negation that begins late in the budget passes past the deadline',
      'not.toHaveURL and not.toHaveClass negations that begin late pass',
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

  it('reports the observed class when toHaveClass fails', () => {
    const result = resultByTitle(outcome, 'class assertions report the observed class on failure');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(result.attempts[0]!.error?.message).toMatch(
      /^expect\.toHaveClass failed\nexpected: class "card inactive"\nobserved: class "card active"$/,
    );
  });

  it('fails a negation that begins after the deadline at the first sample past it, with no window line', () => {
    const title = resultByTitle(outcome, 'a late not.toHaveTitle fails at the first sample past the deadline');
    expect(title.status).toBe('failed');
    expect(title.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(title.attempts[0]!.error?.message).toMatch(
      /^expect\.not\.toHaveTitle failed\nexpected: not title "Fixture Home"\nobserved: title "Fixture Home"$/,
    );
    const visible = resultByTitle(outcome, 'a late not.toBeVisible fails at the first sample past the deadline');
    expect(visible.status).toBe('failed');
    expect(visible.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    // The web engine reads once per sample, so no sample straddles the
    // deadline and the window line never applies here; the unit test with a
    // slow read pins that line.
    expect(visible.attempts[0]!.error?.message).toMatch(
      /^expect\.not\.toBeVisible failed\nlocator: getByText\("Card"\)\nexpected: not visible\nobserved: default states \(match count 1\)$/,
    );
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

  it('fails a body that returns before a step it started finished with STEP_NOT_AWAITED', () => {
    const result = resultByTitle(outcome, 'a step call without await');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });
    expect(attempt.error?.message).toContain('app.open');
    // A vitest fork reports raw transformed positions; test-source.test.ts covers the mapped line.
    expect(attempt.error?.source?.file).toBe('tests/kitchen.e2e.ts');
    expect(attempt.steps).toHaveLength(1);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    expect(outcome.report.run.errors.map((error) => error.code)).toEqual([]);
  });

  it('keeps the body error primary and notes the un-awaited step beside it', () => {
    const result = resultByTitle(outcome, 'a step call without await before the body throws');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors.map((error) => error.code)).toEqual(['STEP_NOT_AWAITED']);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    expect(outcome.report.run.errors.map((error) => error.code)).toEqual([]);
  });

  it('fails UI operations before open with APP_NOT_OPEN', () => {
    const result = resultByTitle(outcome, 'acting before open fails with APP_NOT_OPEN');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('APP_NOT_OPEN');
  });

  it('denies navigation to a forbidden scheme', () => {
    const result = resultByTitle(outcome, 'forbidden URL schemes are refused');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
  });

  it('exits with configuration precedence and writes report.json', () => {
    // POLICY_DENIED failures classify as configuration errors, and exit-code
    // precedence is 130 > 4 > 3 > 2 > 1 > 0.
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
