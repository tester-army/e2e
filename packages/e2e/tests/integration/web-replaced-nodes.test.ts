/**
 * Visibility reads against a field the page swaps for an identical clone on
 * every animation frame. A read that lands on the node a frame already
 * replaced must re-resolve, never report the visible field hidden; a stable
 * field that shares its candidate set still reads as shown, and a field that
 * is really removed still reads as hidden. Among a crowd of fields replaced
 * every frame, a stable field resolves and an absent one reads as hidden
 * without waiting out the churn.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const READS = 30;

const fields = (screen) => ({
  testId: screen.getByTestId('nickname'),
  label: screen.getByLabel('Nickname', { exact: true }),
  displayValue: screen.getByDisplayValue('ada'),
});

/** How many of READS reads of each locator report it hidden. */
const hiddenReads = async (locators) => {
  const hidden = {};
  for (const [kind, locator] of Object.entries(locators)) {
    hidden[kind] = 0;
    for (let read = 0; read < READS; read += 1) {
      if (await locator.isHidden()) hidden[kind] += 1;
    }
  }
  return hidden;
};

test('a field replaced every frame never reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  expect(await hiddenReads(fields(screen))).toEqual({ testId: 0, label: 0, displayValue: 0 });
});

test('a stable field beside one replaced every frame reads as shown', async ({ app, screen }) => {
  await app.open('/replaced');
  const city = {
    label: screen.getByLabel('City', { exact: true }),
    displayValue: screen.getByDisplayValue('paris'),
  };
  expect(await hiddenReads(city)).toEqual({ label: 0, displayValue: 0 });
});

for (const kind of ['testId', 'label', 'displayValue']) {
  test('toBeHidden fails on a field replaced every frame: ' + kind, async ({ app, screen }) => {
    await app.open('/replaced');
    await expect(fields(screen)[kind]).toBeHidden({ timeout: 500 });
  });
}

test('a stable field among fields replaced every frame resolves promptly', async ({ app, screen }) => {
  await app.open('/replaced-crowd');
  const city = [screen.getByLabel('City', { exact: true }), screen.getByDisplayValue('paris')];
  for (let round = 0; round < 5; round += 1) {
    for (const field of city) {
      await expect(field).toBeVisible({ timeout: 1_000 });
      await expect(field).toHaveCount(1, { timeout: 1_000 });
    }
  }
  for (const absent of [screen.getByLabel('Nickname', { exact: true }), screen.getByDisplayValue('ada')]) {
    await expect(absent).toBeHidden({ timeout: 1_000 });
  }
});

test('a field removed while it is being replaced reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  await expect(screen.getByTestId('nickname')).toBeVisible();
  await screen.getByRole('button', { name: 'Remove' }).tap();
  for (const field of Object.values(fields(screen))) {
    await expect(field).toBeHidden();
    expect(await field.isHidden()).toBe(true);
  }
});
`;

describe('reads of a node replaced every frame', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // Ninety sequential reads against a page that swaps nodes every frame: on a
    // loaded CI runner each read takes far longer than locally, and the suite
    // asserts what the reads return, not how fast they are.
    ({ outcome, project } = await runProject(
      { 'tests/replaced.e2e.ts': SUITE },
      { appUrl: app.url, config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 90_000 } },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('never reads the live field as hidden through a detached node', () => {
    const result = resultByTitle(outcome, 'a field replaced every frame never reads as hidden');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('reads a stable neighbor of a replaced field without tripping on it', () => {
    const result = resultByTitle(outcome, 'a stable field beside one replaced every frame reads as shown');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it.each(['testId', 'label', 'displayValue'])('fails toBeHidden on the live field by %s', (kind) => {
    const result = resultByTitle(outcome, `toBeHidden fails on a field replaced every frame: ${kind}`);
    expect(result.status).toBe('failed');
    // A last sample that lands on a replaced node past the deadline reports the locator unresolved.
    expect(['ASSERTION_FAILED', 'LOCATOR_NOT_FOUND']).toContain(result.attempts[0]!.error?.code);
  });

  it('resolves a stable field among churning candidates within a short deadline', () => {
    const result = resultByTitle(outcome, 'a stable field among fields replaced every frame resolves promptly');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('still reads a genuinely removed field as hidden', () => {
    const result = resultByTitle(outcome, 'a field removed while it is being replaced reads as hidden');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });
});
