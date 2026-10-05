/**
 * The adaptive trace cache end to end: a first run records
 * the step's action trace, the second replays it zero-turn without invoking
 * the executor, a diverged trace hands the step over mid-step with the
 * replayedPrefix notice, and a passing step rewrites its entry. Real
 * Playwright observations and actions throughout.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createScriptedInstance } from '../helpers/scripted-model.ts';
import { createFakeEngine, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import {
  createProject,
  resultByTitle,
  runExisting,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type {
  ReplayedPrefix,
  StepExecutor,
  StepExecutorContext,
} from '../../src/agent/executor.ts';
import type { ActionTrace, TraceEntry } from '../../src/cache/trace.ts';

const SUITE = `import { test, expect } from 'e2e';

test('cached step increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('2');
});
`;

interface ExecutorRecord {
  calls: number;
  prefixes: (ReplayedPrefix | undefined)[];
}

/**
 * Taps Increment until the counter reads 2, resuming after any replayed
 * prefix rather than redoing it. No AI SDK, no model.
 */
function twoTapExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'two-tap-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      const alreadyDone = context.replayedPrefix?.replayedActions.length ?? 0;
      let observation = await context.observe();
      for (let tap = alreadyDone; tap < 2; tap += 1) {
        const id = nodeIdFor(observation.text, /button "Increment"/);
        await context.actions.tap({ id });
        observation = await context.observe();
      }
      if (!/"Counter"[^\n]*(text|value)="2"|status[^\n]*"2"/.test(observation.text)) {
        return { status: 'failed' as const, summary: 'the counter did not reach 2' };
      }
      return { status: 'passed' as const, summary: 'the counter shows 2' };
    },
  };
}

function actStep(outcome: RunOutcome) {
  const attempt = resultByTitle(outcome, 'cached step increments twice').attempts.at(-1)!;
  const step = attempt.steps.find((candidate) => candidate.api === 'agent.act');
  expect(step).toBeDefined();
  return step!;
}

function cacheDir(project: FixtureProject): string {
  return path.join(project.dir, '.e2e', 'cache');
}

/** The single entry the suite wrote, as (path, parsed entry). */
function readOnlyEntry(project: FixtureProject): { file: string; entry: TraceEntry } {
  const entries = readEntries(project);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

/** Rewrites the single entry's payload in place: the shape of a store holding a stale or damaged recording. */
function rewriteOnlyEntry(project: FixtureProject, edit: (payload: ActionTrace) => ActionTrace): void {
  const { file, entry } = readOnlyEntry(project);
  writeFileSync(file, JSON.stringify({ ...entry, payload: edit(entry.payload) }, null, 2), 'utf8');
}

/** The one entry file's bytes and modification time, to prove a replay left it alone. */
function entryFileState(project: FixtureProject): { bytes: string; mtimeMs: number } {
  const { file } = readOnlyEntry(project);
  return { bytes: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
}

describe('trace cache: divergence hands the step over mid-step', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let secondRun: RunOutcome;
  const first: ExecutorRecord = { calls: 0, prefixes: [] };
  const second: ExecutorRecord = { calls: 0, prefixes: [] };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/act.e2e.ts': SUITE });
    const options = (record: ExecutorRecord) => ({
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) } },
        cache: 'read-write' as const,
      },
    });
    await runExisting(project, options(first));
    // Sabotage the second recorded action's descriptor: relocation must fail
    // there, after the first action already replayed against the live page.
    rewriteOnlyEntry(project, (payload) => {
      const [firstTap, secondTap] = payload.actions;
      if (firstTap === undefined || secondTap?.name !== 'tap') throw new Error(`expected two taps, got ${JSON.stringify(payload.actions)}`);
      return { ...payload, actions: [firstTap, { ...secondTap, target: { ...secondTap.target, name: 'No Such Button' } }] };
    });
    secondRun = await runExisting(project, options(second));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands the executor the replayed prefix and still passes', () => {
    expect(secondRun.exitCode).toBe(0);
    expect(second.calls).toBe(1);
    const prefix = second.prefixes[0];
    expect(prefix).toBeDefined();
    expect(prefix!.replayedActions).toHaveLength(1);
    expect(prefix!.totalActions).toBe(2);
    expect(prefix!.stopReason).toBe('target-not-found');
    const step = actStep(secondRun);
    expect(step.cache).toMatchObject({
      mode: 'agent-concluded',
      reason: 'target-not-found',
      replayedActions: 1,
      totalActions: 2,
      detail: expect.stringMatching(/^at action 2 of 2, /u),
      write: 'saved',
    });
  });

  it('rewrites the entry on pass, healing the sabotaged descriptor', () => {
    const { entry } = readOnlyEntry(project);
    expect(entry.payload.actions[1]).toMatchObject({ name: 'tap', target: { name: 'Increment' } });
  });
});

const WRONG_EXPECT_SUITE = `import { test, expect } from 'e2e';

test('cached step increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('3', { timeout: 500 });
});
`;

const WRONG_EXPECT_WITH_TEARDOWN_SUITE = `import { test, expect } from 'e2e';

test.afterEach(async ({ app }) => {
  await app.open();
});

test('cached step increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('3', { timeout: 500 });
});
`;

describe('trace cache: unconfirmed traces are withheld and poisoned entries evicted', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: ExecutorRecord[] = [];

  const options = () => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('teardown steps passing after the failure cannot confirm the implicated trace', async () => {
    project = createProject({ 'tests/act.e2e.ts': WRONG_EXPECT_WITH_TEARDOWN_SUITE });
    const outcome = await runExisting(project, options());
    expect(outcome.exitCode).not.toBe(0);
    // The afterEach hook's app.open passes with a higher step index than the
    // failed assertion; confirmation must stop at the failure, not at it.
    expect(existsSync(cacheDir(project))).toBe(false);
    project.cleanup();
  }, 120_000);

  it('evicts a previously good entry once its flow is implicated in a failure', async () => {
    project = createProject({ 'tests/act.e2e.ts': SUITE });
    await runExisting(project, options());
    expect(readdirSync(cacheDir(project))).toHaveLength(1);
    // Same instruction, stricter assertion: the replay self-finalizes, the
    // assertion fails, and the entry must be evicted rather than kept.
    writeFileSync(path.join(project.dir, 'tests', 'act.e2e.ts'), WRONG_EXPECT_SUITE, 'utf8');
    const outcome = await runExisting(project, options());
    expect(outcome.exitCode).not.toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    expect(readdirSync(cacheDir(project))).toHaveLength(0);
  }, 240_000);
});

const PROVIDER_DOWN_ASSERT_SUITE = `import { test } from 'e2e';

test('cached step increments twice', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await agent.assert('the counter shows 2', { agent: 'judge' });
});
`;

const PROVIDER_DOWN_THEN_WRONG_AFTER_EACH_SUITE = `import { test, expect } from 'e2e';

test.afterEach(async ({ screen }) => {
  await expect(screen.getByRole('status')).toHaveText('3', { timeout: 500 });
});

test('cached step increments twice', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await agent.assert('the counter shows 2', { agent: 'judge' });
});
`;

/** A model whose provider never answers: every request fails, as with a missing key or an outage. */
const unreachableModel = createScriptedInstance('fake', 'unreachable', async () => {
  throw new Error('401 Unauthorized: no API key was provided');
});

/** The code the named step of the only test failed with. */
function stepErrorCode(outcome: RunOutcome, api: string): string | undefined {
  const attempt = resultByTitle(outcome, 'cached step increments twice').attempts.at(-1)!;
  return attempt.steps.find((candidate) => candidate.api === api)?.error?.code;
}

describe('trace cache: a model that never answered implicates nothing', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const record: ExecutorRecord = { calls: 0, prefixes: [] };

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const recordEntry = async (): Promise<void> => {
    project = createProject({ 'tests/act.e2e.ts': SUITE });
    await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) } },
        cache: 'read-write' as const,
      },
    });
  };

  it('keeps an entry replayed whole when a later judgment finds no model', async () => {
    await recordEntry();
    const recorded = entryFileState(project);
    writeFileSync(path.join(project.dir, 'tests', 'act.e2e.ts'), PROVIDER_DOWN_ASSERT_SUITE, 'utf8');
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) }, judge: { model: unreachableModel } },
        cache: 'read-write' as const,
      },
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(actStep(outcome).cache?.mode).toBe('self-finalized');
    expect(stepErrorCode(outcome, 'agent.assert')).toBe('MODEL_PROVIDER_FAILED');
    expect(entryFileState(project)).toEqual(recorded);
    project.cleanup();
  }, 240_000);

  it('keeps an entry whose replay handed off to a model that never answered', async () => {
    await recordEntry();
    rewriteOnlyEntry(project, (payload) => {
      const [firstTap, secondTap] = payload.actions;
      if (firstTap === undefined || secondTap?.name !== 'tap') throw new Error(`expected two taps, got ${JSON.stringify(payload.actions)}`);
      return { ...payload, actions: [firstTap, { ...secondTap, target: { ...secondTap.target, name: 'No Such Button' } }] };
    });
    const handedOff = entryFileState(project);
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { model: unreachableModel } },
        cache: 'read-write' as const,
      },
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(actStep(outcome).cache).toMatchObject({ mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1 });
    expect(stepErrorCode(outcome, 'agent.act')).toBe('MODEL_PROVIDER_FAILED');
    expect(entryFileState(project)).toEqual(handedOff);
    project.cleanup();
  }, 240_000);

  it('still evicts the replayed entry when a later assertion fails on the app', async () => {
    await recordEntry();
    writeFileSync(path.join(project.dir, 'tests', 'act.e2e.ts'), PROVIDER_DOWN_THEN_WRONG_AFTER_EACH_SUITE, 'utf8');
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) }, judge: { model: unreachableModel } },
        cache: 'read-write' as const,
      },
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(actStep(outcome).cache?.mode).toBe('self-finalized');
    expect(stepErrorCode(outcome, 'agent.assert')).toBe('MODEL_PROVIDER_FAILED');
    expect(readEntries(project)).toHaveLength(0);
    project.cleanup();
  }, 240_000);
});

const STORAGE_SUITE = `import { test, expect } from 'e2e';

test('saves the marker', async ({ app, agent, screen }) => {
  await app.open('/storage');
  await agent.act('save the marker');
  await expect(screen.getByLabel('Marker')).toHaveText('saved');
});
`;

/** Taps "Save marker" once (unless a replayed prefix already did) and checks the marker. */
function saveMarkerExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'save-marker-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      let observation = await context.observe();
      if ((context.replayedPrefix?.replayedActions.length ?? 0) === 0) {
        await context.actions.tap({ id: nodeIdFor(observation.text, /button "Save marker"/) });
        observation = await context.observe();
      }
      if (!/"Marker"[^\n]*text="saved"/.test(observation.text)) {
        return { status: 'failed' as const, summary: 'the marker was not saved' };
      }
      return { status: 'passed' as const, summary: 'the marker reads saved' };
    },
  };
}

describe('trace cache: the recorded end state gates self-finalization', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: ExecutorRecord[] = [];

  const options = () => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: saveMarkerExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/storage.e2e.ts': STORAGE_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records the effect of a same-path mutation as end anchors and replays on them', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const { entry } = readOnlyEntry(project);
    expect(entry.payload.startPath).toBe('/storage');
    expect(entry.payload.endPath).toBe('/storage');
    expect(entry.payload.endAnchors).toContainEqual({ role: 'status', name: 'Marker', text: 'saved' });

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    const step = resultByTitle(second, 'saves the marker').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
  }, 240_000);
});

const TOOLS_ONLY_SUITE = `import { test } from 'e2e';

test('tools-only step', async ({ agent }) => {
  await agent.act('do the work with your own tools');
});
`;

describe('trace cache: an engine-independent executor is not gated by the cache', () => {
  it('skips the end-state observation when the executor recorded no actions', async () => {
    const project = createProject({ 'tests/tools.e2e.ts': TOOLS_ONLY_SUITE });
    let executorFinished = false;
    let observationsAfterStep = 0;
    const { engine, operations } = createFakeEngine({
      observe: () => {
        if (executorFinished) observationsAfterStep += 1;
      },
    });
    try {
      const outcome = await runExisting(project, {
        appUrl: FAKE_APP_URL,
        config: {
          targets: [{ name: 'toy', platform: 'web', engine }],
          cache: 'read-write',
          agents: {
            default: {
              executor: {
                name: 'observation-only-executor',
                async runStep(context) {
                  await context.observe();
                  executorFinished = true;
                  return { status: 'passed', summary: 'the screen already matches' };
                },
              },
            },
          },
        },
      });
      expect(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);
      expect(operations.some((operation) => operation.method === 'observe')).toBe(true);
      expect(executorFinished).toBe(true);
      expect(observationsAfterStep).toBe(0);
      expect(existsSync(cacheDir(project))).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});

describe('trace cache: modes', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('--no-cache overrides the config: nothing is recorded, and an entry recorded without it is left untouched', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    const options = (record: ExecutorRecord, noCache: boolean) => ({
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) } },
        cache: 'read-write' as const,
      },
      runOptions: { noCache },
    });
    try {
      const uncached: ExecutorRecord = { calls: 0, prefixes: [] };
      const first = await runExisting(project, options(uncached, true));
      expect(first.exitCode).toBe(0);
      expect(uncached.calls).toBe(1);
      expect(existsSync(cacheDir(project))).toBe(false);
      expect(actStep(first).cache).toBeUndefined();

      const second = await runExisting(project, options({ calls: 0, prefixes: [] }, false));
      expect(second.exitCode).toBe(0);
      const recorded = entryFileState(project);

      // Neither replayed nor rewritten: the entry keeps its bytes and its mtime.
      const again: ExecutorRecord = { calls: 0, prefixes: [] };
      const third = await runExisting(project, options(again, true));
      expect(third.exitCode).toBe(0);
      expect(again.calls).toBe(1);
      expect(actStep(third).cache).toBeUndefined();
      expect(entryFileState(project)).toEqual(recorded);
    } finally {
      project.cleanup();
    }
  }, 180_000);

  it('caches by default, and CI demotes an unset mode to read-only: it replays the entry and never rewrites it', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    const options = (record: ExecutorRecord, env?: NodeJS.ProcessEnv) => ({
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        agents: { default: { executor: twoTapExecutor(record) } },
      },
      ...(env === undefined ? {} : { runOptions: { env } }),
    });
    try {
      const first = await runExisting(project, options({ calls: 0, prefixes: [] }));
      expect(first.exitCode).toBe(0);
      expect(readdirSync(cacheDir(project))).toHaveLength(1);

      // An entry from before the occurrence fields: a read-write replay would complete and rewrite it.
      const { file, entry } = readOnlyEntry(project);
      const { testId, targetId, instructionDigest } = entry.payload.recordedFor!;
      writeFileSync(file, JSON.stringify({ ...entry, payload: { ...entry.payload, recordedFor: { testId, targetId, instructionDigest } } }), 'utf8');
      const legacy = entryFileState(project);
      const inCi: ExecutorRecord = { calls: 0, prefixes: [] };
      const second = await runExisting(project, options(inCi, { ...process.env, APP_URL: app.url, CI: '1' }));
      expect(second.exitCode).toBe(0);
      expect(inCi.calls).toBe(0);
      expect(actStep(second).cache).toEqual({ mode: 'self-finalized', replayedActions: 2, totalActions: 2, entry: expect.stringMatching(/^[0-9a-f]{64}$/u) });
      expect(entryFileState(project)).toEqual(legacy);
    } finally {
      project.cleanup();
    }
  }, 180_000);
});

const PIN_SUITE = `import { test, expect } from 'e2e';

test('picks the red pin', async ({ app, agent, screen }) => {
  await app.open('/canvas');
  await agent.act('pick the red pin on the map');
  await expect(screen.getByRole('status')).toHaveText('red');
});
`;

/** Taps the red pin, drawn at CSS (300, 60) on a canvas the tree does not list. No model. */
function pinExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'pin-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      await context.observe();
      const tapped = await context.actions.tapAt({ x: 300, y: 60 });
      return { status: 'passed', summary: tapped.summary };
    },
  };
}

describe('trace cache: a bare-point tap replays like a coordinate-driven tool', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: ExecutorRecord[] = [];

  const options = () => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: pinExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/pin.e2e.ts': PIN_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records the point with its viewport and replays it zero-turn on the same-sized viewport', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const { entry } = readOnlyEntry(project);
    expect(entry.payload.actions).toEqual([
      { name: 'tapAt', summary: 'tap the point (300, 60)', point: { x: 300, y: 60 }, viewport: { width: 1280, height: 720 } },
    ]);
    expect(entry.payload.endAnchors).toContainEqual({ role: 'status', name: 'Hit', text: 'red' });

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    const step = resultByTitle(second, 'picks the red pin').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
    expect(step.events.filter((event) => event.kind === 'engine').map((event) => event.name)).toEqual(['tapAt']);
  }, 240_000);
});

const TODOS_SUITE = `import { test, expect } from 'e2e';

test('adds a todo', async ({ app, agent, screen }) => {
  await app.open('/todos');
  await agent.act('add a todo for groceries');
  await expect(screen.getByRole('list', { name: 'Todos' })).toContainText('Buy milk');
});
`;

/**
 * Types a todo it composes itself, "Buy milk", then taps Add: the shape of a
 * model that made up the flow's data. The value is in neither the instruction
 * nor the params, so only the screen could make it look derived.
 */
function todoExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'todo-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      let observation = await context.observe();
      await context.actions.type({ id: nodeIdFor(observation.text, /textbox "New todo"/) }, 'Buy milk');
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Add"/) });
      observation = await context.observe();
      if (!/status "Result"[^\n]*text="added"/.test(observation.text)) {
        return { status: 'failed' as const, summary: 'the todo was not added' };
      }
      return { status: 'passed' as const, summary: 'the list shows Buy milk' };
    },
  };
}

describe('trace cache: a replayed typed value is the flow\'s data on an app that keeps state', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: ExecutorRecord[] = [];

  const options = () => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: todoExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  const cacheOf = (outcome: RunOutcome) =>
    resultByTitle(outcome, 'adds a todo').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/todos.e2e.ts': TODOS_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('replays the typed value on the second and third run although the first run left it on screen', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const recorded = readOnlyEntry(project).entry.payload.actions;
    expect(recorded.map((action) => action.name)).toEqual(['type', 'tap']);
    expect(recorded[0]).toMatchObject({ name: 'type', value: 'Buy milk' });

    // The list now shows "Buy milk" before the step starts: the start-path
    // probe puts it among the texts the screen showed, where a live type of
    // the same value would count as read off the screen.
    for (const run of [2, 3]) {
      const outcome = await runExisting(project, options());
      expect(outcome.exitCode).toBe(0);
      expect(records.at(-1)!.calls, `run ${String(run)}`).toBe(0);
      const step = cacheOf(outcome);
      expect(step.cache, `run ${String(run)}`).toMatchObject({ mode: 'self-finalized', replayedActions: 2, totalActions: 2 });
      expect(step.metrics!.modelCalls).toBe(0);
      const restaged = readOnlyEntry(project).entry.payload.actions;
      expect(restaged, `run ${String(run)}`).toEqual(recorded);
    }
  }, 360_000);

  it('still records a gap when the executor itself types a value the screen shows', async () => {
    // A fresh project against the same app: no entry, so the executor runs
    // live and types "Buy milk" while the list already shows it.
    const fresh = createProject({ 'tests/todos.e2e.ts': TODOS_SUITE });
    try {
      const first = await runExisting(fresh, options());
      expect(first.exitCode).toBe(0);
      expect(records.at(-1)!.calls).toBe(1);
      const actions = readOnlyEntry(fresh).entry.payload.actions;
      expect(actions.map((action) => action.name)).toEqual(['tool', 'tap']);
      expect(actions[0]).toEqual({ name: 'tool', summary: 'tool type (run-time value)', derived: 'whole-node' });

      const second = await runExisting(fresh, options());
      expect(second.exitCode).toBe(0);
      expect(records.at(-1)!.calls).toBe(1);
      expect(cacheOf(second).cache).toMatchObject({ mode: 'missed', reason: 'gap', totalActions: 2 });
    } finally {
      fresh.cleanup();
    }
  }, 240_000);
});

const ROW_FIELDS_SUITE = `import { test, expect } from 'e2e';

test('fills both row fields', async ({ app, agent, screen }) => {
  await app.open('/row-fields');
  await agent.act('fill the two fields with short words of your choice');
  await expect(screen.getByRole('status')).toHaveText('one+two');
});
`;

/** Every node id whose observation line matches, in document order. */
function nodeIdsFor(observedText: string, pattern: RegExp): string[] {
  return observedText
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => /#(\S+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * Types "one" and "two" into the two unnamed textboxes: words the model
 * composed, which happen to appear inside the row labels beside the fields.
 * No model.
 */
function rowWordsExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'row-words-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      const observation = await context.observe();
      const [first, second] = nodeIdsFor(observation.text, /^\s*#\S+ textbox\b/);
      await context.actions.type({ id: first! }, 'one');
      await context.actions.type({ id: second! }, 'two');
      return { status: 'passed' as const, summary: 'filled both fields' };
    },
  };
}

describe('trace cache: a composed word that appears on screen is not a run-time value', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: ExecutorRecord[] = [];

  const options = () => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: rowWordsExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/rows.e2e.ts': ROW_FIELDS_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records both fills verbatim and replays the whole step on the second run', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const { entry } = readOnlyEntry(project);
    // "one" sits inside "Row one" on screen, and is still the model's own
    // word: neither fill is recorded as a run-time value gap.
    expect(entry.payload.actions.map((action) => action.name)).toEqual(['type', 'type']);
    expect(entry.payload.actions.map((action) => ('value' in action ? action.value : undefined))).toEqual(['one', 'two']);
    expect(entry.payload.endAnchors).toContainEqual({ role: 'status', name: 'Filled', text: 'one+two' });

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    const step = resultByTitle(second, 'fills both row fields').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 2, totalActions: 2 });
  }, 240_000);
});
