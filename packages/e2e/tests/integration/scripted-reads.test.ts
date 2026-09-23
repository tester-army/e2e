/**
 * Locator reads and queries through the real runner against the scripted
 * engine: every read answers from the current tree without waiting, secure
 * fields refuse value reads, strictness applies to reads, every query kind
 * and refinement resolves, and malformed refinements are refused before any
 * query runs.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { failed, passed, scriptedSuite, step } from '../helpers/scripted-suite.ts';

const READS = `import { test, expect } from 'e2e';

test('reads answer from the current tree', async ({ app, screen }) => {
  await app.open('/');
  expect(await screen.getByRole('heading', { level: 1 }).textContent()).toBe('Dashboard');
  expect(await screen.getByRole('image', { name: 'Map' }).textContent()).toBeNull();
  expect(await screen.getByLabel('Search').inputValue()).toBe('hello-value');
  expect(await screen.getByRole('heading', { level: 1 }).inputValue()).toBe('');
  expect(await screen.getByTestId('card').getAttribute('class')).toBe('card active');
  expect(await screen.getByTestId('card').getAttribute('missing')).toBeNull();
  expect(await screen.getByRole('button', { name: 'Submit' }).isVisible()).toBe(true);
  expect(await screen.getByText('Hidden content').isVisible()).toBe(false);
  expect(await screen.getByText('Hidden content').isHidden()).toBe(true);
  expect(await screen.getByText('Never rendered').isVisible()).toBe(false);
  expect(await screen.getByText('Never rendered').isHidden()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Submit' }).isEnabled()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isEnabled()).toBe(false);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isDisabled()).toBe(true);
  expect(await screen.getByRole('switch', { name: 'Dark mode' }).isChecked()).toBe(true);
  expect(await screen.getByRole('checkbox', { name: 'Notifications' }).isChecked()).toBe(false);
  expect(await screen.getByRole('button', { name: 'Submit' }).boundingBox()).toEqual({ x: 20, y: 200, width: 100, height: 40 });
  expect(await screen.getByRole('heading', { level: 1 }).boundingBox()).toBeNull();
  expect(await screen.getByTestId('todo').count()).toBe(3);
  expect(await screen.getByTestId('missing').count()).toBe(0);
  const items = await screen.getByTestId('todo').all();
  expect(items).toHaveLength(3);
  const texts: string[] = [];
  for (const item of items) texts.push((await item.textContent()) ?? '');
  expect(texts).toEqual(['Write spec', 'Ship runner', 'Release']);
  expect(await screen.getByTestId('todo').allTextContents()).toEqual(texts);
  expect(await screen.getByTestId('missing').all()).toEqual([]);
  expect(await screen.getByTestId('missing').allTextContents()).toEqual([]);
  await screen.getByRole('button', { name: 'Submit' }).waitFor();
  await screen.getByRole('button', { name: 'Submit' }).waitFor({ state: 'visible' });
  await screen.getByText('Hidden content').waitFor({ state: 'hidden' });
  await screen.getByText('Never rendered').waitFor({ state: 'hidden' });
});

test('secure fields still answer state reads', async ({ app, screen }) => {
  await app.open('/');
  expect(await screen.getByLabel('Password').isEnabled()).toBe(true);
  expect(await screen.getByLabel('Password').isChecked()).toBe(false);
  expect(await screen.getByLabel('Password').isVisible()).toBe(true);
  expect(await screen.getByLabel('Password').boundingBox()).toEqual({ x: 10, y: 140, width: 200, height: 30 });
});

test('textContent on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').textContent();
});

test('inputValue on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').inputValue();
});

test('getAttribute on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').getAttribute('type');
});

test('allTextContents over a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('textbox').allTextContents();
});

test('a read of zero matches is LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Never rendered').textContent();
});

test('a read of several matches is LOCATOR_AMBIGUOUS', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').textContent();
});

test('isVisible on several matches is LOCATOR_AMBIGUOUS', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').isVisible();
});

test('isDisabled on zero matches is LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).isDisabled();
});

test('waitFor times out with LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).waitFor({ timeout: 50 });
});

test('every query kind and refinement resolves', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'sub', exact: false })).toBeVisible();
  await expect(screen.getByRole('button', { name: /^Sub/ })).toBeVisible();
  await expect(screen.getByRole('img', { name: 'Map' })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 2 })).toHaveText('Recent');
  await expect(screen.getByRole('heading')).toHaveCount(2);
  await expect(screen.getByRole('tab', { selected: true })).toHaveText('All');
  await expect(screen.getByRole('button', { disabled: true })).toHaveAccessibleName('Disabled action');
  await expect(screen.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(screen.getByRole('button', { name: 'Menu', expanded: false })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Bold', pressed: false })).toBeVisible();
  await expect(screen.getByText('Ready')).toHaveCount(2);
  await expect(screen.getByRole('status', { name: 'Ready state' })).toHaveCount(1);
  await expect(screen.getByText('Ready', { visible: true })).toHaveCount(1);
  await expect(screen.getByText('Ready', { visible: true })).toBeVisible();
  await expect(screen.getByLabel('Email')).toBeVisible();
  await expect(screen.getByLabel('email', { exact: false })).toBeVisible();
  await expect(screen.getByLabel(/^Em/)).toBeVisible();
  await expect(screen.getByPlaceholder('you@example.test')).toHaveAccessibleName('Email');
  await expect(screen.getByPlaceholder('EXAMPLE', { exact: false })).toHaveCount(1);
  await expect(screen.getByText('Card body')).toBeVisible();
  await expect(screen.getByText('card BODY', { exact: false })).toBeVisible();
  await expect(screen.getByText(/^Card/)).toBeVisible();
  await expect(screen.getByText('Echoed')).toHaveCount(1);
  await expect(screen.getByDisplayValue('hello-value')).toHaveAccessibleName('Search');
  await expect(screen.getByDisplayValue(/^hello/)).toHaveCount(1);
  await expect(screen.getByDisplayValue('hunter2')).toHaveCount(0);
  await expect(screen.getByTestId('card')).toBeVisible();
  await expect(screen.getByTestId('todos').getByRole('checkbox')).toHaveCount(3);
  await expect(screen.getByTestId('todos').getByRole('listitem').filter({ hasText: 'ship' })).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').filter({ hasText: /^Write/ })).toHaveCount(1);
  await expect(screen.getByTestId('todo').filter({ has: screen.getByRole('checkbox', { checked: true }) })).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').filter({ hasText: 'Release', has: screen.getByRole('checkbox') })).toHaveCount(1);
  await expect(screen.getByTestId('todo').filter({ hasText: 'Release', has: screen.getByRole('checkbox', { checked: true }) })).toHaveCount(0);
  await expect(screen.getByTestId('todo').first()).toHaveText('Write spec');
  await expect(screen.getByTestId('todo').last()).toHaveText('Release');
  await expect(screen.getByTestId('todo').nth(1)).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').nth(7)).toHaveCount(0);
  await expect(screen.getByTestId('todo').filter({ hasText: 'Ship' }).getByRole('checkbox')).toBeChecked();
  await expect(screen.getByRole('list', { name: 'Todos' }).getByText('Release')).toBeVisible();
});

test('filter without a predicate is INVALID_LOCATOR', async ({ app, screen }) => {
  await app.open('/');
  screen.getByTestId('todo').filter({});
});

test('a negative index is INVALID_LOCATOR', async ({ app, screen }) => {
  await app.open('/');
  screen.getByTestId('todo').nth(-1);
});

test('acting before open is APP_NOT_OPEN', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Submit' }).tap({ timeout: 200 });
});
`;

describe('scripted engine: locator reads and queries', () => {
  const run = scriptedSuite('reads.e2e.ts', READS);

  it('reads every field, count, and list without waiting', () => {
    assertValidReport(run.outcome.report);
    const attempt = passed(run.outcome, 'reads answer from the current tree');
    expect(attempt.steps.filter((entry) => entry.api === 'locator.waitFor')).toHaveLength(4);
    expect(step(attempt, 'locator.waitFor').label).toBe('getByRole("button", name: "Submit") → visible');
    passed(run.outcome, 'secure fields still answer state reads');
  });

  it('refuses value reads on a secure field with POLICY_DENIED', () => {
    for (const title of [
      'textContent on a secure field is denied',
      'inputValue on a secure field is denied',
      'getAttribute on a secure field is denied',
      'allTextContents over a secure field is denied',
    ]) {
      const attempt = failed(run.outcome, title, 'POLICY_DENIED', 'reading values from a secure field is denied');
      expect(attempt.error?.category).toBe('configuration');
    }
  });

  it('applies strictness to reads', () => {
    failed(run.outcome, 'a read of zero matches is LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'matched no nodes', 'getByText("Never rendered")');
    failed(run.outcome, 'a read of several matches is LOCATOR_AMBIGUOUS', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes, expected exactly one');
    failed(run.outcome, 'isVisible on several matches is LOCATOR_AMBIGUOUS', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    failed(run.outcome, 'isDisabled on zero matches is LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'matched no nodes');
    const waited = failed(run.outcome, 'waitFor times out with LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'did not become visible');
    expect(step(waited, 'locator.waitFor').status).toBe('failed');
  });

  it('resolves every query kind and refinement', () => {
    passed(run.outcome, 'every query kind and refinement resolves');
  });

  it('rejects malformed refinements before any query runs', () => {
    failed(run.outcome, 'filter without a predicate is INVALID_LOCATOR', 'INVALID_LOCATOR', 'filter() requires hasText and/or has');
    failed(run.outcome, 'a negative index is INVALID_LOCATOR', 'INVALID_LOCATOR', 'nonnegative integer');
    failed(run.outcome, 'acting before open is APP_NOT_OPEN', 'APP_NOT_OPEN', 'no app is open');
  });
});
