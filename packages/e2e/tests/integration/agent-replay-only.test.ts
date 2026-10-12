/** Replay-only runs on a real surface: no model, no executor hand-off, no store mutations. */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import { createScriptedInstance } from '../helpers/scripted-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const TITLE = 'recorded counter';
const SUITE = `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment twice');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});`;

const runStep = vi.fn<StepExecutor['runStep']>(async (ctx) => {
  const observation = await ctx.observe();
  const id = nodeIdFor(observation.text, /button "Increment"/u);
  await ctx.actions.tap({ id });
  await ctx.actions.tap({ id });
  return { status: 'passed', summary: 'incremented twice' };
});
const executor: StepExecutor = { name: 'record-counter', runStep };
const projects: FixtureProject[] = [];
let app: FixtureApp;

/** Makes a project that each case removes. */
function project(source = SUITE): FixtureProject {
  const created = createProject({ 'tests/counter.e2e.ts': source });
  projects.push(created);
  return created;
}

/** Records a flow with a deterministic executor, then proves the recording exists. */
async function recorded(): Promise<FixtureProject> {
  const created = project();
  const outcome = await runExisting(created, {
    appUrl: app.url,
    config: { agents: { default: { executor } } },
  });
  expect(outcome.exitCode).toBe(0);
  expect(readEntries(created)).toHaveLength(1);
  runStep.mockClear();
  return created;
}

beforeAll(async () => { app = await startFixtureApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => {
  projects.splice(0).forEach((created) => created.cleanup());
  runStep.mockClear();
});

describe('replay-only', () => {
  it('replays without any configured model and leaves the entry byte-for-byte unchanged', async () => {
    const created = await recorded();
    const file = readEntries(created)[0]!.file;
    const before = readFileSync(file, 'utf8');
    const outcome = await runExisting(created, { appUrl: app.url, runOptions: { replayOnly: true } });
    expect(outcome.exitCode).toBe(0);
    assertValidReport(outcome.report);
    const step = resultByTitle(outcome, TITLE).attempts[0]!.steps.find((item) => item.api === 'agent.act');
    expect(step).toMatchObject({ cache: { mode: 'self-finalized' }, metrics: { modelCalls: 0 } });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('never calls configured acting or judgment providers', async () => {
    const created = await recorded();
    const generate = vi.fn(async () => { throw new Error('provider must not be called'); });
    const model = createScriptedInstance('test', 'forbidden', generate);
    const outcome = await runExisting(created, {
      appUrl: app.url,
      config: { cache: { replayOnly: true }, agents: { default: { model, judge: model } } },
    });
    expect(outcome.exitCode).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('replays again on a retry caused by a deterministic assertion', async () => {
    const created = await recorded();
    const source = SUITE.replace("import { test, expect } from 'e2e';", `import { test, expect } from 'e2e';
      import { existsSync, writeFileSync } from 'node:fs';
      const marker = new URL('./retried', import.meta.url);`)
      .replace("await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');", `
        await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
        const retried = existsSync(marker);
        writeFileSync(marker, 'yes');
        expect(retried).toBe(true);`);
    writeFileSync(`${created.dir}/tests/counter.e2e.ts`, source);
    const outcome = await runExisting(created, { appUrl: app.url, config: { retries: 1, cache: { replayOnly: true } } });
    expect(outcome.exitCode).toBe(0);
    const attempts = resultByTitle(outcome, TITLE).attempts;
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.steps.find((item) => item.api === 'agent.act')).toMatchObject({
        cache: { mode: 'self-finalized' }, metrics: { modelCalls: 0 },
      });
    }
  });

  it('fails a missing recording without acquiring a model', async () => {
    const outcome = await runExisting(project(), { appUrl: app.url, runOptions: { replayOnly: true } });
    expect(outcome.exitCode).toBe(2);
    expect(resultByTitle(outcome, TITLE).attempts[0]!.error).toMatchObject({ code: 'REPLAY_MISSING' });
  });

  it('refuses a partially replayed recording without invoking the executor or evicting it', async () => {
    const created = await recorded();
    const { file, entry } = readEntries(created)[0]!;
    const action = entry.payload.actions[1]!;
    if (action.name !== 'tap') throw new Error('expected tap');
    const modified = { ...entry, payload: { ...entry.payload, actions: [entry.payload.actions[0]!, { ...action, target: { role: 'button', name: 'Removed' } }] } };
    writeFileSync(file, JSON.stringify(modified));
    const before = readFileSync(file, 'utf8');
    const outcome = await runExisting(created, {
      appUrl: app.url,
      config: { cache: { replayOnly: true }, agents: { default: { executor } }, actionTimeout: 2_000 },
    });
    expect(outcome.exitCode).toBe(2);
    expect(runStep).not.toHaveBeenCalled();
    const step = resultByTitle(outcome, TITLE).attempts[0]!.steps.find((item) => item.api === 'agent.act');
    expect(step).toMatchObject({ error: { code: 'REPLAY_MISSING' }, metrics: { modelCalls: 0 }, cache: { replayedActions: 1 } });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fails a legacy recording stored under another key without falling back live', async () => {
    const created = await recorded();
    const { file, entry } = readEntries(created)[0]!;
    const provenance = entry.payload.recordedFor!;
    const modified = { ...entry, payload: { ...entry.payload, recordedFor: {
      testId: provenance.testId, targetId: provenance.targetId, instructionDigest: provenance.instructionDigest,
    } } };
    writeFileSync(file, JSON.stringify(modified));
    renameSync(file, file.replace(/[a-f0-9]{64}\.json$/u, `${'f'.repeat(64)}.json`));
    const outcome = await runExisting(created, { appUrl: app.url, config: { cache: { replayOnly: true } } });
    expect(outcome.exitCode).toBe(2);
    expect(resultByTitle(outcome, TITLE).attempts[0]!.error).toMatchObject({ code: 'REPLAY_MISSING' });
  });

  it.each(['assert', 'waitFor', 'extract'] as const)('refuses agent.%s before resolving a model', async (method) => {
    const call = method === 'extract' ? `await agent.extract('counter', { schema: z.string() });`
      : `await agent.${method}('the counter is visible');`;
    const created = project(`import { test } from 'e2e';\nimport { z } from 'zod';
      test('${TITLE}', async ({ agent }) => { ${call} });`);
    const outcome = await runExisting(created, { config: { cache: { replayOnly: true } } });
    expect(outcome.exitCode).toBe(2);
    const step = resultByTitle(outcome, TITLE).attempts[0]!.steps.find((item) => item.api === `agent.${method}`);
    expect(step).toMatchObject({ error: { code: 'REPLAY_MISSING' }, metrics: { modelCalls: 0 } });
  });

  it('refuses custom assertions and executors that opt out of caching', async () => {
    for (const method of ['act', 'assert']) {
      const created = project(`import { test } from 'e2e';
        test('${TITLE}', async ({ agent }) => { await agent.${method}('increment twice'); });`);
      const outcome = await runExisting(created, {
        config: { cache: { replayOnly: true }, agents: { default: { executor: { ...executor, cache: 'off' } } } },
      });
      expect(outcome.exitCode).toBe(2);
      expect(resultByTitle(outcome, TITLE).attempts[0]!.error).toMatchObject({ code: 'REPLAY_MISSING' });
    }
    expect(runStep).not.toHaveBeenCalled();
  });
});
