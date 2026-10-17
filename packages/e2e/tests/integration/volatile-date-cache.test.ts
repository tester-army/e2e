/** A date on the end screen, recorded one day and replayed the next, in real Chromium; no model. */

import { expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { expectReplayed, onlyActStep, readEntries } from '../helpers/trace-cache.ts';

const TITLE = 'places an order';

it.each(['ar-long', 'ar-numeric', 'en-numeric'])('replays an order dated %s on the next day', async (format) => {
  const app = await startFixtureApp();
  const project = createProject({
    'tests/order.e2e.ts': `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open('/order?format=${format}');
  await agent.act('Place an order');
  await expect(screen.getByRole('status')).toHaveText('Order placed');
});`,
  });
  let calls = 0;
  const executor: StepExecutor = {
    name: 'order',
    version: 'test',
    async runStep(context) {
      calls += 1;
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Place order"/) });
      await context.observe();
      return { status: 'passed', summary: 'order placed' };
    },
  };
  const config = { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, cache: 'read-write' as const };
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config });
    expect(recorded.exitCode).toBe(0);
    expect(readEntries(project)[0]?.entry.payload.endAnchors).toContainEqual({ role: 'status', name: 'Order placed' });
    calls = 0;
    app.setVariant('next-day');
    const replayed = await runExisting(project, { appUrl: app.url, config, runOptions: { strictCache: true } });
    expect(replayed.exitCode).toBe(0);
    expect(calls).toBe(0);
    expectReplayed(onlyActStep(replayed, TITLE), 1);
  } finally {
    project.cleanup();
    await app.close();
  }
}, 120_000);
