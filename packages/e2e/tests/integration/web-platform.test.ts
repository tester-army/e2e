import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const KITCHEN_SINK = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('deterministic queries and reads', async ({ app, screen, browser }) => {
  await app.open();

  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(screen.getByLabel('Email')).toBeVisible();
  await expect(screen.getByPlaceholder('you@example.test')).toBeVisible();
  await expect(screen.getByText('Item Alpha')).toBeVisible();
  await expect(screen.getByDisplayValue('hello-value')).toBeVisible();
  await expect(screen.getByTestId('items')).toBeVisible();

  await expect(screen.getByTestId('item')).toHaveCount(3);
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
  await expect(screen.getByTestId('item')).not.toContainText(['Gamma', 'Alpha'], { timeout: 200 });
  await expect(screen.getByTestId('item')).not.toHaveText(['Item Alpha', 'Item Beta'], { timeout: 200 });

  expect(await screen.getByTestId('items').getAttribute('class')).toBeNull();
  expect(await browser.locator('#class-card').getAttribute('class')).toBe('card active');
  expect(await screen.getByLabel('Readonly').getAttribute('readonly')).toBe('');
  expect(await browser.locator('#fixture-image').getAttribute('src')).toBe('/fixture.png');
  expect(await browser.locator('#class-card').getAttribute('constructor')).toBe('own');
  expect(await screen.getByTestId('items').getAttribute('constructor')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('toString')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('__proto__')).toBeNull();
});

test('class assertions report the observed class on failure', async ({ app, browser }) => {
  await app.open();
  try {
    await expect(browser).toHaveClass(browser.locator('#class-card'), 'card inactive', { timeout: 300 });
    throw new Error('toHaveClass unexpectedly passed');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('class "card active"')) throw error;
  }
});

test('a textarea value compares raw', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1\\n\\nline2  ');
  await expect(screen.getByLabel('Notes')).toHaveValue(/^line1\\n\\nline2 {2}$/);
  await expect(screen.getByLabel('Notes')).not.toHaveValue('line1 line2', { timeout: 200 });
});

test('a textarea value is never normalized to match', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1 line2', { timeout: 500 });
});

test('toHaveAttribute reads the value attribute of plain fields', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Plain')).toHaveAttribute('value', 'marker-5e0c');
  await expect(screen.getByLabel('Blank')).not.toHaveAttribute('value', { timeout: 200 });
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

test('routes are attempt-scoped: registered before the first page, kept across restart and clearState', async ({
  app,
  browser,
  screen,
}) => {
  await browser.route('**/api/flags', (route) => route.fulfill({ json: { betaBoard: true } }));
  await app.open('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.restart();
  await browser.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.clearState();
  await browser.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
});

test('evaluate keeps a nested named binding the loader compiled', async ({ app, browser }) => {
  await app.open();
  // A nested named binding survives serialization whatever the loader
  // compiled it to (esbuild keepNames once wrapped it in a \`__name\` helper).
  const total = await browser.evaluate((input: { a: number; b: number }) => {
    const pick = (key: 'a' | 'b') => input[key];
    return pick('a') + pick('b');
  }, { a: 2, b: 40 });
  expect(total).toBe(42);
});

test('reads under an absent frame answer with no match', async ({ app, browser }) => {
  await app.open('/frame');
  const absent = browser.frameLocator('#absent').getByRole('button');
  expect(await absent.count()).toBe(0);
  expect(await absent.all()).toEqual([]);
  expect(await absent.allTextContents()).toEqual([]);
  expect(await absent.isVisible()).toBe(false);
  expect(await absent.isHidden()).toBe(true);
});

test('a nested absent frame counts as zero matches at once', async ({ app, browser }) => {
  await app.open('/frame-nested');
  expect(await browser.frameLocator('#outer').frameLocator('#absent').getByRole('button').count()).toBe(0);
});

test('absence matchers and waits under an absent frame pass at once', async ({ app, browser }) => {
  await app.open('/frame');
  const absent = browser.frameLocator('#absent').getByRole('button');
  await expect(absent).toBeAttached({ attached: false, timeout: 3000 });
  await expect(absent).toBeVisible({ visible: false, timeout: 3000 });
  await expect(absent).toBeHidden({ timeout: 3000 });
  await absent.waitFor({ state: 'detached', timeout: 3000 });
  await absent.waitFor({ state: 'hidden', timeout: 3000 });
});

test('an action under an absent frame polls for the frame until its timeout', async ({ app, browser }) => {
  await app.open('/frame');
  await browser.frameLocator('#absent').getByRole('button').tap({ timeout: 800 });
});

test('downloads are captured as artifacts', async ({ app, browser }) => {
  await app.open('/downloads');
  const download = await browser.waitForDownload(() => browser.locator('a[download]').tap());
  if (download.suggestedFilename !== 'report.csv') throw new Error(download.suggestedFilename);
  if (!download.path.startsWith('downloads/')) throw new Error(download.path);
});

test('clicks hold the modifiers they name', async ({ app, screen, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<button>Pick</button><p role="status"></p>';
    const button = document.querySelector('button')!;
    const status = document.querySelector('p')!;
    const held = (event: MouseEvent) =>
      [event.type, event.shiftKey && 'shift', event.altKey && 'alt', event.ctrlKey && 'ctrl', event.metaKey && 'meta']
        .filter(Boolean)
        .join(' ');
    button.addEventListener('click', (event) => { status.textContent = held(event); });
    button.addEventListener('dblclick', (event) => { status.textContent = held(event); });
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); status.textContent = held(event); });
    return null;
  });
  const pick = screen.getByRole('button', { name: 'Pick' });
  const status = screen.getByRole('status');
  await pick.click({ modifiers: ['Shift'] });
  await expect(status).toHaveText('click shift');
  await pick.doubleTap({ modifiers: ['Alt'] });
  await expect(status).toHaveText('dblclick alt');
  await pick.secondaryTap({ modifiers: ['Shift', 'Control'] });
  await expect(status).toHaveText('contextmenu shift ctrl');
  await pick.tap();
  await expect(status).toHaveText('click');
});

test('a trigger that starts no download times out saying so', async ({ app, browser }) => {
  await app.open('/downloads');
  await browser.waitForDownload(() => new Promise((resolve) => setTimeout(resolve, 200)), { timeout: 500 });
});

test('a viewport set before the first navigation holds through app.open', async ({ app, browser }) => {
  const size = { width: 390, height: 600 };
  await browser.setViewport(size);
  size.width = 1000;
  await app.open();
  const width = await browser.evaluate(() => window.innerWidth);
  if (width !== 390) throw new Error('innerWidth ' + width);
  await app.restart();
  const restarted = await browser.evaluate(() => window.innerWidth);
  if (restarted !== 390) throw new Error('innerWidth after restart ' + restarted);
  await app.clearState();
  await app.open();
  const cleared = await browser.evaluate(() => window.innerWidth);
  if (cleared !== 390) throw new Error('innerWidth after clearState ' + cleared);
});

test('a viewport set before the first navigation opens no page', async ({ screen, browser }) => {
  await browser.setViewport({ width: 390, height: 600 });
  await screen.getByTestId('items').tap({ timeout: 200 });
});

test('a *css= capture is refused before the last selector part', async ({ app, browser }) => {
  await app.open();
  await expect(browser.locator('css=ul[data-testid="items"] >> *css=li')).toHaveCount(3);
  let capture = 'no error';
  try {
    await browser.locator('*css=ul[data-testid="items"] >> li').count();
  } catch (error) {
    capture = (error as Error).message;
  }
  expect(capture).toContain('a selector that captures with * (*css=article >> text=Hello) is not supported');
});

test('forbidden URL schemes are refused', async ({ app }) => {
  await app.open();
  await app.open('javascript:alert(1)');
});

test('a route handler assertion that no step follows', async ({ app, browser }) => {
  await browser.route('**/api/flags.js', async (route) => {
    await route.fulfill({ body: '', contentType: 'text/javascript' });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/script-flags');
});

test('a dialog handler assertion that no step follows', async ({ app, browser, screen }) => {
  await app.open('/dialog');
  await browser.onDialog(async (dialog) => {
    await dialog.accept();
    expect(dialog.message).toBe('Are you sure?');
  });
  await screen.getByRole('button', { name: 'Ask' }).tap();
});

`;

const LATE_HANDLER_THEN_TEARDOWN = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.afterEach(async ({ app }) => {
  await app.open('/');
});

test('a route handler assertion that no step follows, then a teardown that navigates', async ({ app, browser }) => {
  await browser.route('**/api/flags.js', async (route) => {
    await route.fulfill({ body: '', contentType: 'text/javascript' });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/script-flags');
});
`;

// A local file the wrapped schemes would load. Each test navigates once and
// fails with POLICY_DENIED; a navigation that went through fails differently.
const WRAPPED_SCHEMES = `import { test } from '@e2e-dev/web';
const marker = new URL('../marker.txt', import.meta.url).href;
const leakCheck = async (browser) => {
  const text = String(await browser.evaluate(() => document.body?.innerText ?? ''));
  if (text.includes('marker-local-file')) throw new Error('LEAKED');
};
for (const url of ['view-source:' + marker, 'VIEW-SOURCE:' + marker, '  view-source:' + marker, 'blob:http://127.0.0.1/x', 'about:srcdoc']) {
  test('app.open refuses ' + JSON.stringify(url), async ({ app, browser }) => {
    await app.open();
    await app.open(url);
    await leakCheck(browser);
  });
}
test('app.open and browser.goto admit about:blank', async ({ app, browser }) => {
  await app.open();
  await app.open('about:blank');
  await browser.goto('about:blank');
  if ((await browser.url()) !== 'about:blank') throw new Error('not blank: ' + (await browser.url()));
});
test('setCookies refuses about:blank', async ({ app, browser }) => {
  await app.open();
  await browser.setCookies([{ name: 'flavor', value: 'oatmeal', url: 'about:blank' }]);
});
test('browser.goto refuses view-source', async ({ app, browser }) => {
  await app.open();
  await browser.goto('view-source:' + marker);
  await leakCheck(browser);
});
`;

// Loaded from a config file, as a project loads it: the engine's `e2e/engine`
// and the runner's core are two module copies, so `instanceof` cannot tell a
// runner error apart and a missing node must still keep the matcher polling.
const CLASSES = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('class assertions poll for a node that arrives late', async ({ app, browser }) => {
  await app.open('/classes');
  await expect(browser).toHaveClass(browser.locator('#late-card'), 'card late', { timeout: 1800 });
});

test('class assertions on an ambiguous locator fail at once', async ({ app, browser }) => {
  await app.open('/classes');
  await expect(browser).toHaveClass(browser.locator('.dup'), 'dup', { timeout: 1800 });
});

test('an empty class attribute is an empty class list', async ({ app, browser }) => {
  await app.open('/classes');
  await expect(browser).toHaveClass(browser.locator('#blank-card'), '');
});

test('a missing class attribute is not an empty class list', async ({ app, browser, screen }) => {
  await app.open('/classes');
  await expect(browser).toHaveClass(screen.getByTestId('items'), '', { timeout: 300 });
});

test('toHaveURL ignoreCase folds the comparison', async ({ app, browser }) => {
  await app.open('/classes');
  await expect(browser).toHaveURL('/CLASSES', { ignoreCase: true });
  await expect(browser).toHaveURL(/CLASSES$/, { ignoreCase: true });
  await expect(browser).not.toHaveURL('/CLASSES', { timeout: 300 });
});

test('a negated toHaveURL ignoreCase fails on a case-folded match', async ({ app, browser }) => {
  await app.open('/classes');
  await expect(browser).not.toHaveURL('/CLASSES', { ignoreCase: true, timeout: 300 });
});
`;

// A predicate, which Playwright accepts and a migrated test may still pass, is
// refused instead of reading as a pattern that matches everything. An option
// the call does not take is refused instead of leaving it on its default.
const URL_PATTERNS = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const toOther: any = (url: URL) => url.pathname === '/other';
const flag = (name, value) => JSON.parse(JSON.stringify({ [name]: value, timeout: 300 }));

test('waitForResponse with a predicate', async ({ app, browser }) => {
  await app.open();
  await Promise.all([browser.waitForResponse(toOther, { timeout: 2_000 }), browser.goto('/flags')]);
});

test('route with a predicate', async ({ app, browser, screen }) => {
  await browser.route(toOther, (route) => route.abort());
  await app.open('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta off');
});

test('unroute with a predicate', async ({ app, browser }) => {
  await app.open();
  await browser.unroute(toOther);
});

test('string and RegExp URL patterns match what they name', async ({ app, browser, screen }) => {
  await app.open('/about');
  await expect(browser).toHaveURL('/about');
  await expect(browser).toHaveURL(/\\/about$/);
  await expect(browser).not.toHaveURL('/other', { timeout: 200 });
  await expect(browser).not.toHaveURL(/\\/other$/, { timeout: 200 });
  await browser.waitForURL(/\\/about$/);
  await browser.route(/\\/other$/, (route) => route.abort());
  await browser.route(/\\/api\\/flags$/, (route) => route.fulfill({ json: { betaBoard: true } }));
  const [response] = await Promise.all([browser.waitForResponse(/\\/api\\/flags$/), browser.goto('/flags')]);
  expect(response.url).toMatch(/\\/api\\/flags$/);
  expect(await response.json()).toEqual({ betaBoard: true });
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await browser.unroute(/\\/api\\/flags$/);
  const [real] = await Promise.all([browser.waitForResponse('**/api/flags'), browser.reload()]);
  expect(await real.json()).toEqual({ betaBoard: false });
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta off');
});

test('an option toHaveTitle does not take is refused', async ({ app, browser }) => {
  await app.open();
  await expect(browser).toHaveTitle('', flag('ignoreCase', true));
});

test('an option waitForURL does not take is refused', async ({ app, browser }) => {
  await app.open();
  await browser.waitForURL('/', flag('waitUntil', 'load'));
});
`;

describe('web platform integration', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile(
      {
        'tests/kitchen.e2e.ts': KITCHEN_SINK,
        'tests/late-handler.e2e.ts': LATE_HANDLER_THEN_TEARDOWN,
        'tests/schemes.e2e.ts': WRAPPED_SCHEMES,
        'tests/classes.e2e.ts': CLASSES,
        'tests/url-patterns.e2e.ts': URL_PATTERNS,
        'marker.txt': 'marker-local-file\n',
      },
      {
        appUrl: app.url,
        configSource: workerConfigSource(1, "\n  cache: 'off',\n  actionTimeout: 5_000,\n  assertionTimeout: 4_000,\n  timeout: 30_000,"),
      },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it.each([
    'deterministic queries and reads',
    'class assertions report the observed class on failure',
    'a textarea value compares raw',
    'toHaveAttribute reads the value attribute of plain fields',
    'routes are attempt-scoped: registered before the first page, kept across restart and clearState',
    'reads under an absent frame answer with no match',
    'a nested absent frame counts as zero matches at once',
    'absence matchers and waits under an absent frame pass at once',
    'a *css= capture is refused before the last selector part',
    'downloads are captured as artifacts',
    'clicks hold the modifiers they name',
    'a viewport set before the first navigation holds through app.open',
    'an empty class attribute is an empty class list',
    'toHaveURL ignoreCase folds the comparison',
    'string and RegExp URL patterns match what they name',
  ])('passes %s', (title) => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('decides absence under an absent frame without waiting out the deadline', () => {
    const result = resultByTitle(outcome, 'absence matchers and waits under an absent frame pass at once');
    const steps = result.attempts[0]!.steps.filter((step) => step.api.startsWith('expect.') || step.api === 'locator.waitFor');
    expect(steps).toHaveLength(5);
    for (const step of steps) expect(step.durationMs, step.api).toBeLessThan(3000);
  });

  it('fails an action under an absent frame with LOCATOR_NOT_FOUND once its timeout has run', () => {
    const result = resultByTitle(outcome, 'an action under an absent frame polls for the frame until its timeout');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_NOT_FOUND');
    const tap = result.attempts[0]!.steps.find((step) => step.api === 'locator.tap');
    expect(tap?.status).toBe('failed');
    expect(tap?.durationMs).toBeGreaterThanOrEqual(800);
  });

  it('fails a download that never started with the wait and the trigger time, not a bare timeout', () => {
    const result = resultByTitle(outcome, 'a trigger that starts no download times out saying so');
    expect(result.status).toBe('failed');
    const error = result.attempts[0]!.error;
    expect(error?.code).toBe('ACTION_FAILED');
    const triggerMs = Number(/^no download started within 500ms; the trigger resolved after (\d+)ms$/.exec(error?.message ?? '')?.[1]);
    // The trigger sleeps 200ms; a timer can fire a millisecond or two early.
    expect(triggerMs).toBeGreaterThanOrEqual(190);
  });

  it('sets a viewport before the first navigation without opening a page', () => {
    const result = resultByTitle(outcome, 'a viewport set before the first navigation opens no page');
    expect(result.attempts[0]!.steps.map((step) => [step.api, step.status])).toEqual([
      ['browser.setViewport', 'passed'],
      ['locator.tap', 'failed'],
    ]);
    expect(result.attempts[0]!.error?.code).toBe('APP_NOT_OPEN');
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
    expect(attempt.steps.map((step) => step.api)).toEqual(['browser.route', 'app.open', 'app.open']);
    const failure = attempt.failure!;
    expect(failure.url).toMatch(/\/script-flags$/);
    const screen = attempt.artifacts.find((artifact) => artifact.id === failure.screen)!;
    const text = readFileSync(path.join(project.dir, '.e2e', 'results', screen.path!), 'utf8');
    expect(text).toContain('heading "Flags"');
    expect(text).not.toContain('heading "Home"');
  });

  it('denies navigation to a forbidden scheme', () => {
    const result = resultByTitle(outcome, 'forbidden URL schemes are refused');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('POLICY_DENIED');
  });

  it('denies a wrapped or non-http(s) scheme on app.open and browser.goto before it loads', () => {
    const titles = [
      'app.open refuses "view-source:file://',
      'app.open refuses "VIEW-SOURCE:file://',
      'app.open refuses "  view-source:file://',
      'app.open refuses "blob:http://127.0.0.1/x"',
      'app.open refuses "about:srcdoc"',
      'browser.goto refuses view-source',
    ];
    for (const title of titles) {
      const result = outcome.results.find((candidate) => candidate.test.title.startsWith(title));
      expect(result, title).toBeDefined();
      expect(result!.status, title).toBe('failed');
      expect(result!.attempts[0]!.error?.code, title).toBe('POLICY_DENIED');
      expect(result!.attempts[0]!.error?.message, title).toMatch(/^forbidden URL scheme: (view-source|blob|about):$/);
    }
    expect(resultByTitle(outcome, 'app.open and browser.goto admit about:blank').status).toBe('passed');
    const cookie = resultByTitle(outcome, 'setCookies refuses about:blank');
    expect(cookie.status).toBe('failed');
    expect(cookie.attempts[0]!.error).toMatchObject({ code: 'POLICY_DENIED', message: 'cookie URL must be http(s): about:blank' });
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
    const waitStep = attempt.steps.find((step) => step.api === 'browser.waitForDownload');
    expect(waitStep?.artifacts).toHaveLength(1);
    const tapStep = attempt.steps.find((step) => step.api === 'locator.tap');
    expect(tapStep?.artifacts ?? []).toHaveLength(0);
    const download = attempt.artifacts.find((artifact) => artifact.kind === 'download');
    expect(download?.path).toContain('downloads/');
    // Bytes the app served, not rewritten by the runner: the record says so.
    expect(download).toMatchObject({ redaction: 'incomplete', mediaType: 'text/csv' });
  });

  it('keeps a class assertion polling while the node is missing and passes once it arrives', () => {
    const result = resultByTitle(outcome, 'class assertions poll for a node that arrives late');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'expect.toHaveClass');
    expect(step?.durationMs).toBeGreaterThan(500);
  });

  it('fails a class assertion on an ambiguous locator with LOCATOR_AMBIGUOUS before the deadline', () => {
    const result = resultByTitle(outcome, 'class assertions on an ambiguous locator fail at once');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_AMBIGUOUS');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'expect.toHaveClass');
    expect(step?.durationMs).toBeLessThan(1800);
  });

  it('matches an empty class string against no class attribute only when one is present', () => {
    const missing = resultByTitle(outcome, 'a missing class attribute is not an empty class list');
    expect(missing.status).toBe('failed');
    expect(missing.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(missing.attempts[0]!.error?.message).toContain('observed: no class attribute');
  });

  it('fails a negated toHaveURL ignoreCase on a case-folded match', () => {
    const negated = resultByTitle(outcome, 'a negated toHaveURL ignoreCase fails on a case-folded match');
    expect(negated.status).toBe('failed');
    expect(negated.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(negated.attempts[0]!.error?.message).toContain('expected: not URL /CLASSES (ignoring case)');
  });

  it.each([
    ['waitForResponse with a predicate', 'browser.waitForResponse'],
    ['route with a predicate', 'browser.route'],
    ['unroute with a predicate', 'browser.unroute'],
  ])('%s fails with INVALID_ARGUMENT at %s', (title, api) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error?.code).toBe('INVALID_ARGUMENT');
    expect(attempt.error?.message).toContain('string or RegExp');
    expect(attempt.steps.find((step) => step.status === 'failed')?.api).toBe(api);
  });

  it.each([
    ['an option toHaveTitle does not take is refused', 'expect.toHaveTitle options has no key "ignoreCase"'],
    ['an option waitForURL does not take is refused', 'browser.waitForURL options has no key "waitUntil"'],
  ])('%s', (title, message) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining(message) });
  });
});
