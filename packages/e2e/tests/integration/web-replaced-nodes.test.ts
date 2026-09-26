/**
 * Visibility reads against a field the page swaps for an identical clone on
 * every animation frame. A read that lands on the node a frame already
 * replaced must re-resolve, never report the visible field hidden; a field
 * that is really removed still reads as hidden.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

const READS = 100;

const fields = (screen) => ({
  testId: screen.getByTestId('nickname'),
  label: screen.getByLabel('Nickname', { exact: true }),
  displayValue: screen.getByDisplayValue('ada'),
});

test('a field replaced every frame never reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  const hidden = { testId: 0, label: 0, displayValue: 0 };
  for (const [kind, field] of Object.entries(fields(screen))) {
    for (let read = 0; read < READS; read += 1) {
      if (await field.isHidden()) hidden[kind] += 1;
    }
  }
  expect(hidden).toEqual({ testId: 0, label: 0, displayValue: 0 });
});

for (const kind of ['testId', 'label', 'displayValue']) {
  test('toBeHidden fails on a field replaced every frame: ' + kind, async ({ app, screen }) => {
    await app.open('/replaced');
    await expect(fields(screen)[kind]).toBeHidden({ timeout: 500 });
  });
}

test('a field removed while it is being replaced reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  await expect(screen.getByTestId('nickname')).toBeVisible();
  await screen.getByRole('button', { name: 'Remove' }).tap();
  for (const field of Object.values(fields(screen))) {
    await expect(field).toBeHidden();
    await expect(field).not.toBeAttached();
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
    ({ outcome, project } = await runProject(
      { 'tests/replaced.e2e.ts': SUITE },
      { appUrl: app.url, config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 30_000 } },
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

  it.each(['testId', 'label', 'displayValue'])('fails toBeHidden on the live field by %s', (kind) => {
    const result = resultByTitle(outcome, `toBeHidden fails on a field replaced every frame: ${kind}`);
    expect(result.status).toBe('failed');
    // A last sample that lands on a replaced node past the deadline reports the locator unresolved.
    expect(['ASSERTION_FAILED', 'LOCATOR_NOT_FOUND']).toContain(result.attempts[0]!.error?.code);
  });

  it('still reads a genuinely removed field as hidden', () => {
    const result = resultByTitle(outcome, 'a field removed while it is being replaced reads as hidden');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });
});
