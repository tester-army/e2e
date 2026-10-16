/**
 * Node actions, the keyboard, and the app hooks through the real runner
 * against the scripted engine: every action kind reaches the engine with the
 * ref and payload the test named, and `app.open`, `back`, `restart`, and
 * `clearState` reach the session hooks.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_APP_URL, type RecordedSessionCall } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { passed, scriptedSuite, step } from '../helpers/scripted-suite.ts';

const ACTIONS = `import { test, expect } from 'e2e';

test('every node action reaches the engine', async ({ app, screen }) => {
  await app.open('/');
  const submit = screen.getByRole('button', { name: 'Submit' });
  await submit.tap();
  await submit.click();
  await submit.doubleTap();
  await submit.dblclick();
  await submit.secondaryTap();
  await submit.longPress();
  await submit.longPress({ duration: 800 });
  await screen.getByLabel('Email').fill('ada@example.test');
  await expect(screen.getByLabel('Email')).toHaveValue('ada@example.test');
  await screen.getByLabel('Email').clear();
  await expect(screen.getByLabel('Email')).toHaveValue('');
  await screen.getByLabel('City').pressSequentially('Wa');
  await expect(screen.getByLabel('City')).toHaveValue('Wa');
  await expect(screen.getByLabel('City')).toBeFocused();
  await screen.getByLabel('City').pressSequentially('rs', { delay: 10 });
  await expect(screen.getByLabel('City')).toHaveValue('Wars');
  await screen.getByLabel('City').press('Backspace');
  await expect(screen.getByLabel('City')).toHaveValue('War');
  await screen.getByLabel('City').press('Shift+Tab');
  await screen.getByLabel('City').press('$');
  await expect(screen.getByLabel('City')).toHaveValue('War$');
  await screen.getByRole('checkbox', { name: 'Notifications' }).check();
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).toBeChecked();
  await screen.getByRole('checkbox', { name: 'Notifications' }).uncheck();
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).not.toBeChecked({ timeout: 500 });
  await screen.getByLabel('Plan').selectOption('Pro');
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await screen.getByLabel('Plan').selectOption({ label: 'Team' });
  await expect(screen.getByLabel('Plan')).toHaveValue('team');
  await screen.getByLabel('Plan').selectOption({ value: 'free' });
  await expect(screen.getByLabel('Plan')).toHaveValue('free');
  await screen.getByLabel('Plan').selectOption({ index: 1 });
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await screen.getByLabel('Focus target').focus();
  await expect(screen.getByLabel('Focus target')).toBeFocused();
  await expect(screen.getByLabel('City')).not.toBeFocused({ timeout: 500 });
  await submit.hover();
  await screen.getByRole('button', { name: 'Attachment' }).setInputFiles('fixtures/one.txt');
  await screen.getByRole('button', { name: 'Attachment' }).setInputFiles(['fixtures/one.txt', '/tmp/two.txt']);
  await screen.getByTestId('drag').dragTo(screen.getByTestId('drop'));
  await submit.scrollIntoView();
  await screen.getByRole('list', { name: 'Feed' }).swipe({ direction: 'down', momentum: 'slow' });
  await screen.getByRole('list', { name: 'Feed' }).swipe({ direction: 'left' });
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Count' })).toHaveText('2');
  await screen.getByRole('button', { name: 'Bold' }).tap();
  await expect(screen.getByRole('button', { name: 'Bold', pressed: true })).toBeVisible();
});

test('app hooks reach the session', async ({ app, screen }) => {
  await app.open('/');
  await app.open('/settings');
  await app.back();
  await app.restart();
  await app.clearState();
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
});
`;

describe('scripted engine: actions and app hooks', () => {
  const run = scriptedSuite('actions.e2e.ts', ACTIONS);

  it('dispatches every action kind with the expected ref and payload', () => {
    assertValidReport(run.outcome.report);
    const attempt = passed(run.outcome, 'every node action reaches the engine');
    const performs = run.fake.callsOf(attempt.id, 'perform').map((entry) => [entry.id, entry.action] as const);
    const fixtureOne = path.join(run.project.dir, 'fixtures', 'one.txt');
    expect(performs).toEqual([
      ['submit', { kind: 'tap' }],
      ['submit', { kind: 'tap' }],
      ['submit', { kind: 'doubleTap' }],
      ['submit', { kind: 'doubleTap' }],
      ['submit', { kind: 'secondaryTap' }],
      ['submit', { kind: 'longPress' }],
      ['submit', { kind: 'longPress', durationMs: 800 }],
      ['email', { kind: 'fill', value: 'ada@example.test', sensitive: false }],
      ['email', { kind: 'clear' }],
      ['city', { kind: 'focus' }],
      ['city', { kind: 'focus' }],
      ['city', { kind: 'press', key: 'Backspace' }],
      ['city', { kind: 'press', key: 'Shift+Tab' }],
      ['city', { kind: 'press', key: '$' }],
      ['notify', { kind: 'check' }],
      ['notify', { kind: 'uncheck' }],
      ['plan', { kind: 'selectOption', value: 'Pro' }],
      ['plan', { kind: 'selectOption', value: { label: 'Team' } }],
      ['plan', { kind: 'selectOption', value: { value: 'free' } }],
      ['plan', { kind: 'selectOption', value: { index: 1 } }],
      ['focus-target', { kind: 'focus' }],
      ['submit', { kind: 'hover' }],
      ['upload', { kind: 'setInputFiles', paths: [fixtureOne] }],
      ['upload', { kind: 'setInputFiles', paths: [fixtureOne, '/tmp/two.txt'] }],
      ['drag', { kind: 'dragTo', target: { id: 'drop', revision: expect.stringMatching(/^l\d+$/) } }],
      ['submit', { kind: 'scrollIntoView' }],
      ['feed', { kind: 'swipe', direction: 'down', momentum: 'slow' }],
      ['feed', { kind: 'swipe', direction: 'left' }],
      ['increment', { kind: 'tap' }],
      ['increment', { kind: 'tap' }],
      ['bold', { kind: 'tap' }],
    ]);
    expect(run.fake.callsOf(attempt.id, 'keyboard')).toEqual([
      { kind: 'keyboard', attemptId: attempt.id, method: 'type', text: 'Wa', replace: false },
      { kind: 'keyboard', attemptId: attempt.id, method: 'type', text: 'r', replace: false },
      { kind: 'keyboard', attemptId: attempt.id, method: 'type', text: 's', replace: false },
    ]);
    expect(run.fake.callsOf(attempt.id, 'performAt')).toEqual([]);
    const apis = attempt.steps.map((entry) => entry.api);
    expect(apis).toEqual(
      expect.arrayContaining([
        'locator.tap', 'locator.click', 'locator.doubleTap', 'locator.dblclick', 'locator.secondaryTap', 'locator.longPress', 'locator.fill',
        'locator.clear', 'locator.pressSequentially', 'locator.press', 'locator.check', 'locator.uncheck',
        'locator.selectOption', 'locator.focus', 'locator.hover', 'locator.setInputFiles', 'locator.dragTo',
        'locator.scrollIntoView', 'locator.swipe',
      ]),
    );
    expect(step(attempt, 'locator.fill').label).toBe('getByLabel("Email")');
    expect(step(attempt, 'locator.pressSequentially').label).toBe('getByLabel("City")');
  });

  it('routes app.open, back, restart, and clearState to the session hooks', () => {
    const attempt = passed(run.outcome, 'app hooks reach the session');
    const session = (method: RecordedSessionCall['method'], url?: string): RecordedSessionCall => ({
      kind: 'session',
      attemptId: attempt.id,
      method,
      ...(url === undefined ? {} : { url }),
    });
    expect(run.fake.callsOf(attempt.id, 'session')).toEqual([
      session('open', `${FAKE_APP_URL}/`),
      session('open', `${FAKE_APP_URL}/settings`),
      session('back'),
      session('restart'),
      session('open', `${FAKE_APP_URL}/`),
      session('reset'),
      session('open', `${FAKE_APP_URL}/`),
    ]);
    expect(attempt.steps.map((entry) => entry.api).slice(0, 5)).toEqual([
      'app.open', 'app.open', 'app.back', 'app.restart', 'app.clearState',
    ]);
  });
});
