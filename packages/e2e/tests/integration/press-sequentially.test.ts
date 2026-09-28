/**
 * `locator.pressSequentially` against a real browser: the fixture's City
 * field renders suggestions on key events only, so `fill` leaves the list
 * empty and `pressSequentially` populates it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('fill sets the value without key events', async ({ app, screen }) => {
  await app.open('/verbs');
  await screen.getByLabel('City').fill('Wa');
  await expect(screen.getByLabel('City')).toHaveValue('Wa');
  await expect(screen.getByRole('status', { name: 'Keys' })).toHaveText('0');
  await expect(screen.getByRole('list', { name: 'Cities' }).getByRole('listitem')).toHaveCount(0);
});

test('pressSequentially types the same text as keystrokes', async ({ app, screen }) => {
  await app.open('/verbs');
  await screen.getByLabel('City').pressSequentially('Wa');
  await expect(screen.getByLabel('City')).toHaveValue('Wa');
  await expect(screen.getByLabel('City')).toBeFocused();
  await expect(screen.getByRole('status', { name: 'Keys' })).toHaveText('2');
  const cities = screen.getByRole('list', { name: 'Cities' }).getByRole('listitem');
  await expect(cities).toHaveCount(1);
  await expect(cities.first()).toHaveText('Warsaw');
});

test('a delay spaces the keystrokes', async ({ app, screen }) => {
  await app.open('/verbs');
  await screen.getByLabel('City').pressSequentially('Wr', { delay: 200 });
  await expect(screen.getByLabel('City')).toHaveValue('Wr');
  await expect(screen.getByRole('status', { name: 'Keys' })).toHaveText('2');
  await expect(screen.getByRole('list', { name: 'Cities' }).getByRole('listitem').first()).toHaveText('Wroclaw');
});
`;

describe('locator.pressSequentially in a browser', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/typing.e2e.ts': SUITE },
      { appUrl: app.url, config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 30_000 } },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('fill reaches the value but never the key handlers', () => {
    const result = resultByTitle(outcome, 'fill sets the value without key events');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });

  it('pressSequentially fires the key handlers and records one locator step', () => {
    const result = resultByTitle(outcome, 'pressSequentially types the same text as keystrokes');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'locator.pressSequentially');
    expect(step).toMatchObject({ kind: 'locator', label: 'getByLabel("City")', status: 'passed' });
  });

  it('honors the delay between characters', () => {
    const result = resultByTitle(outcome, 'a delay spaces the keystrokes');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'locator.pressSequentially');
    expect(step?.durationMs).toBeGreaterThanOrEqual(200);
  });
});
