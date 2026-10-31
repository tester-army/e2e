/** An age in words on the end screen, recorded right after a refresh and replayed minutes later, in real Chromium; no model. */

import { expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { expectReplayed, onlyActStep, readEntries } from '../helpers/trace-cache.ts';

const TITLE = 'refreshes the reports';

it.each(['moment', 'date-fns', 'app'])('replays a refresh whose %s age reads otherwise minutes later', async (format) => {
  const app = await startFixtureApp();
  const project = createProject({
    'tests/refresh.e2e.ts': `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open('/refresh?format=${format}');
  await agent.act('Refresh the reports');
  await expect(screen.getByRole('status')).toHaveText('Refreshed');
});`,
  });
  let calls = 0;
  const executor: StepExecutor = {
    name: 'refresh',
    version: 'test',
    async runStep(context) {
      calls += 1;
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Refresh"/) });
      await context.observe();
      return { status: 'passed', summary: 'refreshed' };
    },
  };
  const config = { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, cache: 'read-write' as const };
  try {
    const recorded = await runExisting(project, { appUrl: app.url, config });
    expect(recorded.exitCode).toBe(0);
    calls = 0;
    app.setVariant('later');
    const replayed = await runExisting(project, { appUrl: app.url, config, runOptions: { strictCache: true } });
    expect(replayed.exitCode).toBe(0);
    expect(calls).toBe(0);
    expectReplayed(onlyActStep(replayed, TITLE), 1);
    expect(readEntries(project)[0]?.entry.payload.endAnchors).toEqual([{ role: 'status', name: 'Refreshed' }]);
  } finally {
    project.cleanup();
    await app.close();
  }
}, 120_000);
