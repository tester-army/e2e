/**
 * URL patterns in a real browser: `toHaveURL`, `waitForURL`, `route`,
 * `unroute`, and `waitForResponse` take a string or a RegExp, as does the
 * text pattern of `toHaveTitle`. A predicate function, which Playwright
 * accepts and a migrated test may still pass, is refused with
 * INVALID_ARGUMENT instead of reading as a pattern that matches everything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

const toOther: any = (url: URL) => url.pathname === '/other';

test('toHaveURL with a predicate', async ({ app, web }) => {
  await app.open('/about');
  await expect(web).toHaveURL(toOther, { timeout: 500 });
});

test('waitForURL with a predicate', async ({ app, web }) => {
  await app.open('/about');
  await web.waitForURL(toOther, { timeout: 500 });
});

test('waitForResponse with a predicate', async ({ app, web }) => {
  await app.open();
  await Promise.all([web.waitForResponse(toOther, { timeout: 2_000 }), web.goto('/flags')]);
});

test('route with a predicate', async ({ app, web, screen }) => {
  await web.route(toOther, (route) => route.abort());
  await app.open('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta off');
});

test('unroute with a predicate', async ({ app, web }) => {
  await app.open();
  await web.unroute(toOther);
});

test('toHaveTitle with a predicate', async ({ app, web }) => {
  await app.open();
  await expect(web).toHaveTitle(toOther, { timeout: 500 });
});

test('string and RegExp URL patterns match what they name', async ({ app, web, screen }) => {
  await app.open('/about');
  await expect(web).toHaveURL('/about');
  await expect(web).toHaveURL(/\\/about$/);
  await expect(web).not.toHaveURL('/other');
  await expect(web).not.toHaveURL(/\\/other$/);
  await web.waitForURL(/\\/about$/);
  await web.route(/\\/other$/, (route) => route.abort());
  await web.route(/\\/api\\/flags$/, (route) => route.fulfill({ json: { betaBoard: true } }));
  const [response] = await Promise.all([web.waitForResponse(/\\/api\\/flags$/), web.goto('/flags')]);
  expect(response.url).toMatch(/\\/api\\/flags$/);
  expect(await response.json()).toEqual({ betaBoard: true });
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await web.unroute(/\\/api\\/flags$/);
  const [real] = await Promise.all([web.waitForResponse('**/api/flags'), web.reload()]);
  expect(await real.json()).toEqual({ betaBoard: false });
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta off');
});
`;

describe('web URL patterns in a browser', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject(
      { 'tests/url-patterns.e2e.ts': SUITE },
      { appUrl: app.url, config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 30_000 } },
    ));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it.each([
    ['toHaveURL with a predicate', 'expect.toHaveURL'],
    ['waitForURL with a predicate', 'web.waitForURL'],
    ['waitForResponse with a predicate', 'web.waitForResponse'],
    ['route with a predicate', 'web.route'],
    ['unroute with a predicate', 'web.unroute'],
    ['toHaveTitle with a predicate', 'expect.toHaveTitle'],
  ])('%s fails with INVALID_ARGUMENT at %s', (title, api) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error?.code).toBe('INVALID_ARGUMENT');
    expect(attempt.error?.message).toContain('string or RegExp');
    expect(attempt.steps.find((step) => step.status === 'failed')?.api).toBe(api);
  });

  it('keeps string and RegExp patterns matching only what they name', () => {
    const result = resultByTitle(outcome, 'string and RegExp URL patterns match what they name');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });
});
