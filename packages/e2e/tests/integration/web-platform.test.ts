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
  await expect(screen.getByTestId('item')).toContainText(['Alpha', 'Gamma']);
  await expect(screen.getByTestId('item')).not.toContainText(['Gamma', 'Alpha']);
  await expect(screen.getByTestId('item')).not.toHaveText(['Item Alpha', 'Item Beta']);

  await expect(screen.getByText('Hidden content')).toBeAttached();
  await expect(screen.getByText('Hidden content')).toBeHidden();
  await expect(screen.getByText('Never rendered')).not.toBeAttached();
  expect(await screen.getByText('Hidden content').isHidden()).toBe(true);
  expect(await screen.getByText('Never rendered').isHidden()).toBe(true);
  await expect(screen.getByTestId('hidden-svg')).toBeHidden();
  await expect(screen.getByTestId('zero-box')).toBeHidden();
  await expect(screen.getByRole('button', { name: 'Inside folded details' })).toBeHidden();
  await expect(screen.getByTestId('empty-contents')).toBeHidden();
  await expect(screen.getByTestId('painted-contents')).toBeVisible();
  expect(await screen.getByTestId('hidden-svg').isVisible()).toBe(false);
  expect(await screen.getByTestId('zero-box').isVisible()).toBe(false);
  expect(await screen.getByRole('button', { name: 'Inside folded details' }).isVisible()).toBe(false);
  expect(await screen.getByTestId('empty-contents').isVisible()).toBe(false);
  expect(await screen.getByTestId('painted-contents').isVisible()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isDisabled()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Increment' }).isDisabled()).toBe(false);

  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
  await expect(screen.getByRole('button', { name: 'Increment' })).toBeEnabled();
  expect(await screen.getByRole('button', { name: 'Fenced action' }).isDisabled()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Legend action' }).isDisabled()).toBe(false);
  await expect(screen.getByRole('button', { name: 'Fenced action' })).toBeDisabled();
  await expect(screen.getByRole('button', { name: 'Legend action' })).toBeEnabled();

  expect(await screen.getByTestId('items').getAttribute('class')).toBeNull();
  expect(await web.locator('#class-card').getAttribute('class')).toBe('card active');
  expect(await screen.getByLabel('Readonly').getAttribute('readonly')).toBe('');
  expect(await web.locator('#fixture-image').getAttribute('src')).toBe('/fixture.png');
  expect(await web.locator('#class-card').getAttribute('constructor')).toBe('own');
  expect(await screen.getByTestId('items').getAttribute('constructor')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('toString')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('__proto__')).toBeNull();
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

  // Name from content for the roles accname allows, the same name on both
  // sides: the role query resolves it and the reader reports it.
  const named: readonly [role: string, name: string][] = [
    ['switch', 'Dark mode'],
    ['columnheader', 'Plan'],
    ['cell', 'Monthly'],
    ['button', 'Shadow action'],
    ['button', 'Clear form'],
    ['button', 'Reset'],
  ];
  for (const [role, name] of named) {
    const control = screen.getByRole(role as 'button', { name, exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAccessibleName(name);
  }
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
  await expect(web.locator('#class-card')).toHaveAttribute('constructor', 'own');
  await expect(screen.getByLabel('Readonly')).not.toHaveAttribute('constructor');
  await expect(screen.getByLabel('Readonly')).not.toHaveAttribute('toString');
  await expect(screen.getByLabel('Readonly')).not.toHaveAttribute('__proto__');

  await screen.getByLabel('Focus target').focus();
  await expect(screen.getByLabel('Focus target')).toBeFocused();
  await expect(screen.getByLabel('Email')).not.toBeFocused();

  await expect(web).toHaveClass(web.locator('#class-card'), 'card active');
  await expect(web).toHaveClass(web.locator('#class-card'), /active/);
  await expect(web).not.toHaveClass(web.locator('#class-card'), 'card inactive');
});

test('check and uncheck refuse an unknown option and leave the box untouched', async ({ app, screen, web }) => {
  await app.open();
  await web.evaluate(() => {
    const box = document.querySelector<HTMLInputElement>('#notifications')!;
    box.dataset.events = '0';
    for (const type of ['input', 'change', 'click']) {
      box.addEventListener(type, () => { box.dataset.events = String(Number(box.dataset.events) + 1); });
    }
  });
  const box = screen.getByLabel('Notifications');
  const code = async (call: () => Promise<void>) => {
    try {
      await call();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'no error';
  };

  expect(await code(() => box.check({ trial: true } as never))).toBe('INVALID_ARGUMENT');
  await expect(box).not.toBeChecked();
  await expect(box).toHaveAttribute('data-events', '0');
  await box.check();
  await expect(box).toBeChecked();
  await expect(box).toHaveAttribute('data-events', '3');

  expect(await code(() => box.uncheck({ trial: true } as never))).toBe('INVALID_ARGUMENT');
  await expect(box).toBeChecked();
  await expect(box).toHaveAttribute('data-events', '3');
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(box).toHaveAttribute('data-events', '6');
});

test('unsupported filter and selectOption shapes fail before acting', async ({ app, screen, web }) => {
  await app.open();
  const code = async (call: () => unknown) => {
    try {
      await call();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'no error';
  };
  const digest = () =>
    web.evaluate(() => [...document.querySelector<HTMLSelectElement>('#digest')!.selectedOptions].map((option) => option.value));

  const mixed = { hasText: 'Item', hasNotText: 'Alpha' } as unknown as { hasText: string };
  expect(await code(() => screen.getByTestId('item').filter(mixed).first().textContent())).toBe('INVALID_LOCATOR');
  await expect(screen.getByTestId('item').filter({ hasText: 'Item' })).toHaveCount(3);
  await expect(screen.getByTestId('item').filter({ hasText: 'Item' }).first()).toHaveText('Item Alpha');

  const several = ['daily', 'weekly'] as unknown as string;
  expect(await code(() => screen.getByLabel('Digest').selectOption(several))).toBe('INVALID_ARGUMENT');
  expect(await digest()).toEqual([]);
  await screen.getByLabel('Digest').selectOption({ value: 'weekly' });
  expect(await digest()).toEqual(['weekly']);
});

test('class assertions report the observed class on failure', async ({ app, web }) => {
  await app.open();
  try {
    await expect(web).toHaveClass(web.locator('#class-card'), 'card inactive', { timeout: 300 });
    throw new Error('toHaveClass unexpectedly passed');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('class "card active"')) throw error;
  }
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

test('a textarea value compares raw', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1\\n\\nline2  ');
  await expect(screen.getByLabel('Notes')).toHaveValue(/^line1\\n\\nline2 {2}$/);
  await expect(screen.getByLabel('Notes')).not.toHaveValue('line1 line2');
});

test('a textarea value is never normalized to match', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1 line2');
});

test('toHaveAttribute reads the value attribute of plain fields', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Plain')).toHaveAttribute('value', 'marker-5e0c');
  await expect(screen.getByLabel('Blank')).not.toHaveAttribute('value');
});

test('toHaveAttribute never judges a secure field', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Secret')).toHaveAttribute('value');
});

test('a negated toHaveAttribute never judges a secure field', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Secret')).not.toHaveAttribute('value');
});

test('a negated toHaveAttribute fails on a plain field that holds the same marker', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Plain')).not.toHaveAttribute('value', { timeout: 500 });
});

test('secure fields refuse value reads', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill('hunter2');
  await screen.getByLabel('Password').inputValue();
});

test('toHaveValue never judges a secure field', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill('marker-9b1f');
  await expect(screen.getByLabel('Password')).toHaveValue('');
});

test('toHaveValue reads a plain field that holds the same marker', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Email').fill('marker-9b1f');
  await expect(screen.getByLabel('Email')).toHaveValue('', { timeout: 500 });
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
  // tsx compiles this file with esbuild keepNames, which wraps the nested
  // const in a \`__name\` helper the serialized source must find in the page.
  const total = await web.evaluate((input: { a: number; b: number }) => {
    const pick = (key: 'a' | 'b') => input[key];
    return pick('a') + pick('b');
  }, { a: 2, b: 40 });
  expect(total).toBe(42);
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

  const absent = web.frameLocator('#absent').getByRole('button');
  const started = Date.now();
  expect(await absent.count()).toBe(0);
  expect(await absent.all()).toEqual([]);
  expect(await absent.allTextContents()).toEqual([]);
  expect(await absent.isVisible()).toBe(false);
  expect(await absent.isHidden()).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('a nested absent frame counts as zero matches at once', async ({ app, web }) => {
  await app.open('/frame-nested');
  const started = Date.now();
  expect(await web.frameLocator('#outer').frameLocator('#absent').getByRole('button').count()).toBe(0);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('an action under an absent frame polls for the frame until its timeout', async ({ app, web }) => {
  await app.open('/frame');
  await web.frameLocator('#absent').getByRole('button').tap({ timeout: 800 });
});

test('contenteditable hosts are textboxes: reached by label, filled, and read as a value', async ({ app, screen }) => {
  await app.open('/editor');
  const notes = screen.getByLabel('Notes');
  await expect(notes).toBeVisible();
  await notes.fill('Hello');
  await expect(notes).toHaveValue('Hello');
  expect(await notes.inputValue()).toBe('Hello');
  await expect(screen.getByTestId('notes')).toHaveValue('Hello');
  // getByRole resolves through Playwright's role selector, which knows a
  // textbox only by an explicit role: a bare host is not found, one with
  // role="textbox" is.
  await expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveCount(0);
  await expect(screen.getByRole('textbox', { name: 'Message' })).toHaveCount(1);
  await screen.getByRole('textbox', { name: 'Message' }).fill('Hi');
  await expect(screen.getByLabel('Message')).toHaveValue('Hi');
});

test('an editor value keeps the whitespace it renders, and an empty editor reads as empty', async ({ app, screen }) => {
  await app.open('/editor');
  const code = screen.getByLabel('Code');
  await expect(code).toHaveValue('  keep spaces  ');
  await expect(code).not.toHaveValue('keep spaces');
  expect(await code.inputValue()).toBe('  keep spaces  ');
  const notes = screen.getByLabel('Notes');
  await expect(notes).toHaveValue('');
  expect(await notes.inputValue()).toBe('');
});

test('nested frame locators resolve each frame inside the one before it', async ({ app, web }) => {
  await app.open('/frame-nested');
  const inner = web.frameLocator('#outer').frameLocator('#child');
  await inner.getByRole('button', { name: 'Frame button' }).tap();
  await expect(inner.getByRole('button', { name: 'Frame clicked' })).toBeVisible();
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

test('a route handler assertion that no step follows', async ({ app, web }) => {
  await web.route('**/api/flags', async (route) => {
    await route.fulfill({ json: { betaBoard: true } });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/flags');
});

test('a dialog handler assertion that no step follows', async ({ app, web, screen }) => {
  await app.open('/dialog');
  await web.onDialog(async (dialog) => {
    await dialog.accept();
    expect(dialog.message).toBe('Are you sure?');
  });
  await screen.getByRole('button', { name: 'Ask' }).tap();
});

test('a step call without await', async ({ app }) => {
  app.open();
});

test('a step call without await before the body throws', async ({ app }) => {
  app.open();
  throw new Error('the body gave up');
});
`;

const LATE_HANDLER_THEN_TEARDOWN = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.afterEach(async ({ app }) => {
  await app.open('/');
});

test('a route handler assertion that no step follows, then a teardown that navigates', async ({ app, web }) => {
  await web.route('**/api/flags', async (route) => {
    await route.fulfill({ json: { betaBoard: true } });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/flags');
});
`;

describe('web platform integration', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/kitchen.e2e.ts': KITCHEN_SINK, 'tests/late-handler.e2e.ts': LATE_HANDLER_THEN_TEARDOWN },
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
      'a textarea value compares raw',
      'toHaveAttribute reads the value attribute of plain fields',
      'role vocabulary: tabs, menus, progress, toolbars, images',
      'actions and state',
      'check and uncheck refuse an unknown option and leave the box untouched',
      'unsupported filter and selectOption shapes fail before acting',
      'assertions poll until the app settles',
      'web navigation, urls, and titles',
      'routes intercept and fulfill',
      'routes are attempt-scoped: registered before the first page, kept across restart and clearState',
      'waitForResponse observes network traffic',
      'evaluate runs trusted code with JSON arguments',
      'cookies round-trip through policy checks',
      'dialogs are handled by registered handlers',
      'frame locators scope queries into iframes',
      'a nested absent frame counts as zero matches at once',
      'nested frame locators resolve each frame inside the one before it',
      'css selectors via web.locator',
      'contenteditable hosts are textboxes: reached by label, filled, and read as a value',
      'downloads are captured as artifacts',
      'app lifecycle: restart preserves storage, clearState clears it',
      'screenshots land in the artifact directory',
    ];
    for (const title of shouldPass) {
      const result = resultByTitle(outcome, title);
      expect(result.status, `${title}: ${JSON.stringify(result.attempts[0]?.error)}`).toBe('passed');
    }
  });

  it('fails an action under an absent frame with LOCATOR_NOT_FOUND once its timeout has run', () => {
    const result = resultByTitle(outcome, 'an action under an absent frame polls for the frame until its timeout');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_NOT_FOUND');
    const tap = result.attempts[0]!.steps.find((step) => step.api === 'locator.tap');
    expect(tap?.status).toBe('failed');
    expect(tap?.durationMs).toBeGreaterThanOrEqual(800);
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

  it('fails toHaveValue on a textarea against the raw value, and prints what it compared', () => {
    // The web engine reports the value raw, and the matcher neither collapses
    // the newlines to match nor prints a string it never compared.
    const result = resultByTitle(outcome, 'a textarea value is never normalized to match');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(result.attempts[0]!.error?.message).toContain('observed: value "line1\\n\\nline2  "');
  });

  it('denies toHaveAttribute on a password field that has a value attribute with POLICY_DENIED, negated too', () => {
    // The engine withholds a secure field's value attribute, so the matcher
    // must not read the gap as absent and pass the negated form.
    for (const title of ['toHaveAttribute never judges a secure field', 'a negated toHaveAttribute never judges a secure field']) {
      const result = resultByTitle(outcome, title);
      expect(result.status, title).toBe('failed');
      expect(result.attempts[0]!.error?.code, title).toBe('POLICY_DENIED');
      expect(result.attempts[0]!.error?.message, title).toContain('reading values from a secure field is denied');
      expect(JSON.stringify(result), title).not.toContain('marker-5e0c');
    }
    const control = resultByTitle(outcome, 'a negated toHaveAttribute fails on a plain field that holds the same marker');
    expect(control.status).toBe('failed');
    expect(control.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(control.attempts[0]!.error?.message).toContain('observed: attribute "value" "marker-5e0c"');
  });

  it('denies secure value reads with POLICY_DENIED', () => {
    const result = resultByTitle(outcome, 'secure fields refuse value reads');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
  });

  it('denies toHaveValue on a filled password field with POLICY_DENIED, never judging it empty', () => {
    // The engine withholds a secure field's value, so the matcher must not
    // read the gap as '' and pass a filled password field as cleared.
    const result = resultByTitle(outcome, 'toHaveValue never judges a secure field');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
    expect(result.attempts[0]!.error?.message).toContain('reading values from a secure field is denied');
    expect(JSON.stringify(result)).not.toContain('marker-9b1f');
    const control = resultByTitle(outcome, 'toHaveValue reads a plain field that holds the same marker');
    expect(control.status).toBe('failed');
    expect(control.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(control.attempts[0]!.error?.message).toContain('observed: value "marker-9b1f"');
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

  it.each([
    ['route', 'a route handler assertion that no step follows'],
    ['dialog', 'a dialog handler assertion that no step follows'],
  ])('fails a %s handler assertion at the attempt end when no step follows it', (_kind, title) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
    expect(attempt.cleanup).toBe('complete');
    expect(outcome.report.run.errors.map((error) => error.code)).toEqual([]);
  });

  it('takes the failure evidence of a late handler assertion before a teardown navigates away', () => {
    const result = resultByTitle(outcome, 'a route handler assertion that no step follows, then a teardown that navigates');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
    expect(attempt.steps.map((step) => step.api)).toEqual(['web.route', 'app.open', 'app.open']);
    const failure = attempt.failure!;
    expect(failure.url).toMatch(/\/flags$/);
    const screen = attempt.artifacts.find((artifact) => artifact.id === failure.screen)!;
    const text = readFileSync(path.join(project.dir, '.e2e', 'artifacts', screen.path!), 'utf8');
    expect(text).toContain('heading "Flags"');
    expect(text).not.toContain('heading "Home"');
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
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download');
    expect(download?.path).toContain('downloads/');
    // Bytes the app served, not rewritten by the runner: the record says so.
    expect(download).toMatchObject({ redaction: 'incomplete', mediaType: 'text/csv' });
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
