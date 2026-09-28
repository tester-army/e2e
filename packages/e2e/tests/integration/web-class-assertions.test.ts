/**
 * `expect(web).toHaveClass` against the web engine loaded the way a project
 * loads it: from a config file, so the engine's `e2e/engine` and the runner's
 * core are two module copies and `instanceof` cannot tell a runner error apart.
 * A node that is not there yet must keep the matcher polling; an ambiguous
 * locator must still fail at once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('class assertions poll for a node that arrives late', async ({ app, web }) => {
  await app.open('/classes');
  await expect(web).toHaveClass(web.locator('#late-card'), 'card late', { timeout: 1800 });
});

test('class assertions on an ambiguous locator fail at once', async ({ app, web }) => {
  await app.open('/classes');
  await expect(web).toHaveClass(web.locator('.dup'), 'dup', { timeout: 1800 });
});

test('an empty class attribute is an empty class list', async ({ app, web }) => {
  await app.open('/classes');
  await expect(web).toHaveClass(web.locator('#blank-card'), '');
});

test('a missing class attribute is not an empty class list', async ({ app, web, screen }) => {
  await app.open('/classes');
  await expect(web).toHaveClass(screen.getByTestId('items'), '', { timeout: 300 });
});
`;

describe('web class assertions', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/classes.e2e.ts': SUITE },
      { appUrl: app.url, configSource: workerConfigSource(1, "\n  cache: 'off',") },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('keeps polling while the node is missing and passes once it arrives', () => {
    const result = resultByTitle(outcome, 'class assertions poll for a node that arrives late');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'expect.toHaveClass');
    expect(step?.durationMs).toBeGreaterThan(500);
  });

  it('fails an ambiguous locator with LOCATOR_AMBIGUOUS before the deadline', () => {
    const result = resultByTitle(outcome, 'class assertions on an ambiguous locator fail at once');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('LOCATOR_AMBIGUOUS');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'expect.toHaveClass');
    expect(step?.durationMs).toBeLessThan(1800);
  });

  it('matches an empty string against class="" and not against a missing attribute', () => {
    expect(resultByTitle(outcome, 'an empty class attribute is an empty class list').status).toBe('passed');
    const missing = resultByTitle(outcome, 'a missing class attribute is not an empty class list');
    expect(missing.status).toBe('failed');
    expect(missing.attempts[0]!.error?.code).toBe('ASSERTION_FAILED');
    expect(missing.attempts[0]!.error?.message).toContain('observed: no class attribute');
  });
});
