/**
 * Playwright's matcher options through the real CLI and browser. The CLI
 * transpiles without type-checking, so an option a matcher does not take
 * reaches the runtime: the ones e2e implements must change the verdict the
 * way Playwright's do, and every other one must fail the call instead of
 * leaving the matcher to pass on its default.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const soon = { timeout: 300 };
// Built at runtime, the way a JavaScript test or a shared helper passes options.
const flag = (name, value) => JSON.parse(JSON.stringify({ [name]: value, ...soon }));

test('state flags expect the opposite state', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notifications')).toBeChecked({ checked: false });
  await expect(screen.getByLabel('Notifications')).toBeChecked(flag('checked', false));
  await expect(screen.getByText('Hidden content')).toBeVisible({ visible: false });
  await expect(screen.getByText('Never rendered')).toBeAttached({ attached: false });
  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeEnabled({ enabled: false });
  await screen.getByLabel('Notifications').check();
  await expect(screen.getByLabel('Notifications')).toBeChecked({ checked: true });
});

test('ignoreCase matches text in any case', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading')).toHaveText('HOME', { ignoreCase: true });
  await expect(screen.getByRole('heading')).toContainText('OM', flag('ignoreCase', true));
  await expect(screen.getByRole('heading')).not.toContainText('home', soon);
});

test('checked false fails on a checked box', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Notifications').check();
  await expect(screen.getByLabel('Notifications')).toBeChecked(flag('checked', false));
});

test('visible false fails on a visible heading', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading')).toBeVisible(flag('visible', false));
});

test('enabled false fails on an enabled button', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'Increment' })).toBeEnabled(flag('enabled', false));
});

test('attached false fails on a hidden node', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Hidden content')).toBeAttached(flag('attached', false));
});

test('a negated ignoreCase match fails on the same text in another case', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading')).not.toContainText('home', flag('ignoreCase', true));
});

test('an option toBeChecked does not take is refused', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notifications')).toBeChecked(flag('indeterminate', true));
});

test('an option toHaveURL does not take is refused', async ({ app, web }) => {
  await app.open();
  await expect(web).toHaveURL('/', flag('ignoreCase', true));
});

test('an option waitForURL does not take is refused', async ({ app, web }) => {
  await app.open();
  await web.waitForURL('/', flag('waitUntil', 'load'));
});
`;

describe('matcher options in a browser', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/options.e2e.ts': SUITE },
      { appUrl: app.url, config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 30_000 } },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it.each(['state flags expect the opposite state', 'ignoreCase matches text in any case'])('%s', (title) => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it.each([
    ['checked false fails on a checked box', 'expected: unchecked'],
    ['visible false fails on a visible heading', 'expected: hidden or absent'],
    ['enabled false fails on an enabled button', 'expected: disabled'],
    ['attached false fails on a hidden node', 'expected: detached'],
    ['a negated ignoreCase match fails on the same text in another case', 'expected: not text containing "home" (ignoring case)'],
  ])('%s', (title, expected) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining(expected) });
  });

  it.each([
    ['an option toBeChecked does not take is refused', 'expect.toBeChecked options has no key "indeterminate"'],
    ['an option toHaveURL does not take is refused', 'expect.toHaveURL options has no key "ignoreCase"'],
    ['an option waitForURL does not take is refused', 'web.waitForURL options has no key "waitUntil"'],
  ])('%s', (title, message) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining(message) });
  });
});
