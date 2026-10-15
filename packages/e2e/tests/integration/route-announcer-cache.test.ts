/** Record and replay around Next.js App Router's route announcer in real Chromium; no model. */

import { expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { expectReplayed, onlyActStep, readEntries } from '../helpers/trace-cache.ts';

const TITLE = 'opens Library';
const SUITE = `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open('/route-announcer');
  await agent.act('Open Library');
  await expect(screen.getByTestId('notes')).toHaveText('Meeting notes');
});`;

it.each([
  ['announced', 'silent', true],
  ['silent', 'announced', true],
  ['announced', 'app-alert', false],
] as const)('records %s, replays %s, passes=%s', async (recordVariant, replayVariant, passes) => {
  const app = await startFixtureApp();
  const project = createProject({ 'tests/library.e2e.ts': SUITE });
  let calls = 0;
  const executor: StepExecutor = {
    name: 'library',
    version: 'test',
    async runStep(context) {
      calls += 1;
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /link "Library"/) });
      await context.observe();
      return { status: 'passed', summary: 'Library opened' };
    },
  };
  const config = { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, cache: 'read-write' as const };
  try {
    app.setVariant(recordVariant);
    const recorded = await runExisting(project, { appUrl: app.url, config });
    expect(recorded.exitCode).toBe(0);
    expect(calls).toBe(1);
    const entries = readEntries(project);
    expect(entries).toHaveLength(1);
    const { entry } = entries[0]!;
    expect(entry!.payload.endPath).toBe('/library');
    expect(entry!.payload.endAnchors).toContainEqual({ text: 'Meeting notes', testId: 'notes' });
    expect(entry!.payload.goneAnchors).toContainEqual({ text: 'Draft notes', testId: 'draft' });
    calls = 0;
    app.setVariant(replayVariant);
    const replayed = await runExisting(project, { appUrl: app.url, config, runOptions: { strictCache: true } });
    expect(calls).toBe(0);
    const step = onlyActStep(replayed, TITLE);
    if (passes) {
      expect(replayed.exitCode).toBe(0);
      expectReplayed(step, 1);
    } else {
      expect(replayed.exitCode).toBe(2);
      expect(step.error?.code).toBe('REPLAY_STALE');
      expect(step.cache?.reason).toBe('end-mismatch');
    }
    expect(entry!.payload.endAnchors?.filter((anchor) => anchor.role === 'alert')).toEqual([]);
  } finally {
    project.cleanup();
    await app.close();
  }
}, 120_000);
