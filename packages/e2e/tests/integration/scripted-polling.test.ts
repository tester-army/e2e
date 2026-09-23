/**
 * Polling, staleness, failure mapping, and scrolling through the real runner
 * against the scripted engine: matchers poll until the tree catches up, a
 * negated matcher holds for its grace window, a missing node is reported
 * after the deadline and an ambiguous one at once, a stale node is
 * re-resolved once, engine refusals map to ACTION_FAILED without a repeat,
 * and `scrollUntilVisible` swipes the viewport until the target shows.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { SCENE_ROOT_ID } from '../helpers/scripted-scene.ts';
import { failed, passed, scriptedSuite, step } from '../helpers/scripted-suite.ts';

const POLLING = `import { test, expect } from 'e2e';

test('a late node passes toBeVisible', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toBeVisible({ timeout: 1500 });
  await screen.getByRole('button', { name: 'Late arrival' }).waitFor({ state: 'visible' });
});

test('a growing count passes toHaveCount', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Load more' }).tap();
  await expect(screen.getByRole('list', { name: 'Growing' }).getByRole('listitem')).toHaveCount(3, { timeout: 1500 });
});

test('a changing value, text, and state pass their matchers', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeDisabled();
  await screen.getByRole('button', { name: 'Advance' }).tap();
  await expect(screen.getByRole('spinbutton', { name: 'Progress' })).toHaveValue('100', { timeout: 1500 });
  await expect(screen.getByRole('status', { name: 'Ticker' })).toHaveText('tock', { timeout: 1500 });
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeEnabled({ timeout: 1500 });
});

test('a negated matcher waits out the grace window', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Hidden content')).not.toBeVisible({ timeout: 1500 });
});

test('a negated matcher waits for the flip, then the grace window', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('status', { name: 'Loading' })).not.toBeVisible({ timeout: 2500 });
  await screen.getByRole('status', { name: 'Loading' }).waitFor({ state: 'hidden' });
});

test('a missing node is LOCATOR_NOT_FOUND after the deadline', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).tap({ timeout: 250 });
});

test('an ambiguous locator fails an action at once', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').tap({ timeout: 3000 });
});

test('a stale node is re-resolved and the action retried once', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Stale' }).tap();
});

test('a possibly committed action is ACTION_FAILED and never repeated', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Commit' }).tap();
});

test('a non-actionable node is ACTION_FAILED', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Flaky' }).tap();
});

test('scrollUntilVisible reveals a node after two root swipes', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Below the fold' })).toHaveCount(0);
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Below the fold' }), { timeout: 3000 });
  await expect(screen.getByRole('button', { name: 'Below the fold' })).toBeVisible();
});

test('scrollUntilVisible times out with LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Never exists' }), { timeout: 350, direction: 'up' });
});
`;

describe('scripted engine: polling, staleness, failure mapping, and scrolling', () => {
  const run = scriptedSuite('polling.e2e.ts', POLLING);

  it('polls until the tree catches up', () => {
    assertValidReport(run.outcome.report);
    const late = passed(run.outcome, 'a late node passes toBeVisible');
    expect(step(late, 'expect.toBeVisible').durationMs).toBeGreaterThanOrEqual(200);
    const growing = passed(run.outcome, 'a growing count passes toHaveCount');
    expect(step(growing, 'expect.toHaveCount').durationMs).toBeGreaterThanOrEqual(300);
    const changing = passed(run.outcome, 'a changing value, text, and state pass their matchers');
    expect(step(changing, 'expect.toHaveValue').durationMs).toBeGreaterThanOrEqual(150);
  });

  it('holds a negated matcher for the grace window', () => {
    const held = passed(run.outcome, 'a negated matcher waits out the grace window');
    expect(step(held, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(900);
    const flipped = passed(run.outcome, 'a negated matcher waits for the flip, then the grace window');
    expect(step(flipped, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(1_150);
  });

  it('reports a missing node after the deadline and an ambiguous one at once', () => {
    const missing = failed(run.outcome, 'a missing node is LOCATOR_NOT_FOUND after the deadline', 'LOCATOR_NOT_FOUND', 'matched no nodes within');
    expect(missing.error?.details).toMatchObject({ role: 'button', name: 'Never exists', waitedMs: expect.any(Number) });
    expect(missing.error?.details?.waitedMs).toBeGreaterThanOrEqual(250);
    expect(run.fake.callsOf(missing.id, 'perform')).toEqual([]);
    const ambiguous = failed(run.outcome, 'an ambiguous locator fails an action at once', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    // At once: well inside the 3000 ms the test allowed the action.
    expect(step(ambiguous, 'locator.tap').durationMs).toBeLessThan(3_000);
    expect(run.fake.callsOf(ambiguous.id, 'perform')).toEqual([]);
  });

  it('re-resolves a stale node and retries the action once', () => {
    const attempt = passed(run.outcome, 'a stale node is re-resolved and the action retried once');
    expect(run.fake.callsOf(attempt.id, 'perform').map((entry) => entry.id)).toEqual(['stale', 'stale~relocated']);
  });

  it('maps engine refusals to ACTION_FAILED without repeating them', () => {
    const committed = failed(run.outcome, 'a possibly committed action is ACTION_FAILED and never repeated', 'ACTION_FAILED', 'the tap may have landed');
    expect(run.fake.callsOf(committed.id, 'perform')).toHaveLength(1);
    expect(committed.error?.category).toBe('test');
    const blocked = failed(run.outcome, 'a non-actionable node is ACTION_FAILED', 'ACTION_FAILED', 'covered by an overlay');
    expect(run.fake.callsOf(blocked.id, 'perform')).toHaveLength(1);
  });

  it('scrolls the viewport until the target shows, or reports LOCATOR_NOT_FOUND', () => {
    const revealed = passed(run.outcome, 'scrollUntilVisible reveals a node after two root swipes');
    expect(run.fake.callsOf(revealed.id, 'perform').map((entry) => [entry.id, entry.action])).toEqual([
      [SCENE_ROOT_ID, { kind: 'swipe', direction: 'down', momentum: 'slow' }],
      [SCENE_ROOT_ID, { kind: 'swipe', direction: 'down', momentum: 'slow' }],
    ]);
    expect(step(revealed, 'screen.scrollUntilVisible').label).toBe('getByRole("button", name: "Below the fold")');
    const gaveUp = failed(run.outcome, 'scrollUntilVisible times out with LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'did not become visible while scrolling');
    const swipes = run.fake.callsOf(gaveUp.id, 'perform');
    expect(swipes.length).toBeGreaterThanOrEqual(1);
    expect(swipes.every((entry) => entry.id === SCENE_ROOT_ID && entry.action.kind === 'swipe' && entry.action.direction === 'up')).toBe(true);
  });
});
