/**
 * A step frame is passive observation: under `screenshot: 'every-step'` the
 * web engine's capture must never consume a failure a route or dialog
 * handler latched, which belongs to the next step or the attempt's end.
 * Driven through the real runner on the web engine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('a route handler assertion that no step follows', async ({ app, browser }) => {
  await browser.route('**/api/flags', async (route) => {
    await route.fulfill({ json: { betaBoard: true } });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/flags');
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

describe('every-step screenshots and handler failures', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/handlers.e2e.ts': SUITE },
      { appUrl: app.url, config: { screenshot: 'every-step', actionTimeout: 5_000, timeout: 30_000 } },
    ));
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it.each(['a route handler assertion that no step follows', 'a dialog handler assertion that no step follows'])(
    'still fails %s, with the step frames kept',
    (title) => {
      const result = resultByTitle(outcome, title);
      expect(result.status).toBe('failed');
      const attempt = result.attempts[0]!;
      expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
      const frames = attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && artifact.producer.kind === 'step');
      expect(frames.length).toBeGreaterThan(0);
      for (const step of attempt.steps) expect(step.events.filter((event) => event.name === 'step.screenshot')).toEqual([]);
    },
  );
});
