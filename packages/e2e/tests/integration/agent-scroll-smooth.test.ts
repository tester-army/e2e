/**
 * Scrolling to a text in a real browser reaches its row when the page keeps
 * scrolling after the swipe resolved. A page read mid-animation counts as
 * landed, and the next swipe adds to the one in flight; the wheel's target
 * accumulates, so no row is skipped, and this pins that on a JS animation and
 * on `scroll-behavior: smooth`, at 450 ms and at 1.5 s.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const ROW = 'Row 120';

const executor: StepExecutor = {
  name: 'scroll-to-row',
  async runStep(context) {
    await context.observe();
    try {
      await context.actions.scrollUntil(ROW, 'down');
    } catch (cause) {
      return { status: 'failed', summary: `${(cause as { code?: string }).code ?? 'ERROR'}: ${(cause as Error).message}`, errorCode: 'STEP_NO_CONCLUSION' };
    }
    const screen = await context.observe();
    return screen.text.includes(ROW)
      ? { status: 'passed', summary: `reached ${ROW}` }
      : { status: 'failed', summary: `${ROW} is not on the screen`, errorCode: 'STEP_NO_CONCLUSION' };
  },
};

let app: FixtureApp;
let project: FixtureProject | undefined;

beforeAll(async () => {
  app = await startFixtureApp();
});

afterAll(async () => {
  project?.cleanup();
  await app?.close();
});

/** The one step's verdict and summary after scrolling `/smooth-scroll?smooth=<mode>` to the row. */
async function scrollThrough(mode: 'none' | 'js' | 'css', ms = 450): Promise<{ status: string; summary: string }> {
  project = createProject({
    'tests/smooth.e2e.ts': `import { test } from 'e2e';
test('reaches the row', async ({ app, agent }) => {
  await app.open('/smooth-scroll?smooth=${mode}&ms=${String(ms)}');
  await agent.act('reach the row');
});`,
  });
  try {
    const outcome = await runExisting(project, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, cache: 'off' } });
    const result = resultByTitle(outcome, 'reaches the row');
    const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act');
    const detail = step?.events.filter((event) => event.kind === 'engine').map((event) => event.detail).join('; ');
    return { status: result.status, summary: `${detail ?? ''} ${JSON.stringify(result.attempts.at(-1)!.error ?? '')}` };
  } finally {
    project.cleanup();
    project = undefined;
  }
}

describe('scroll_to a text on a page that animates its scroll', () => {
  it.each([['none', 450], ['js', 450], ['js', 1500], ['css', 450]] as const)('reaches the row with smooth=%s over %i ms', async (mode, ms) => {
    const result = await scrollThrough(mode, ms);
    expect(result.status, result.summary).toBe('passed');
  }, 120_000);
});
