/**
 * The adaptive trace cache end to end (RFC0001 cache-in): a first run records
 * the step's action trace, the second replays it zero-turn without invoking
 * the executor, a diverged trace hands the step over mid-step with the
 * replayedPrefix notice, and a passing step rewrites its entry. Real
 * Playwright observations and actions throughout.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import {
  createProject,
  resultByTitle,
  runExisting,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import type {
  ReplayedPrefix,
  StepExecutor,
  StepExecutorContext,
} from '../../src/agent/executor.ts';

const SUITE = `import { test, expect } from '@e2edev/e2e';

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

/** The single entry the suite wrote, as (path, parsed document). */
function readOnlyEntry(project: FixtureProject): { file: string; document: any } {
  const files = readdirSync(cacheDir(project)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  const file = path.join(cacheDir(project), files[0]!);
  return { file, document: JSON.parse(readFileSync(file, 'utf8')) };
}

describe('trace cache: record then zero-turn replay', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let firstRun: RunOutcome;
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
        agent: twoTapExecutor(record),
        cache: 'read-write' as const,
      },
    });
    firstRun = await runExisting(project, options(first));
    secondRun = await runExisting(project, options(second));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('runs the executor on the first pass and records one entry', () => {
    expect(firstRun.exitCode).toBe(0);
    expect(first.calls).toBe(1);
    expect(first.prefixes).toEqual([undefined]);
    const step = actStep(firstRun);
    expect(step.cache).toEqual({
      mode: 'missed',
      reason: 'no-entry',
      replayedActions: 0,
      totalActions: 0,
    });
    expect(readdirSync(cacheDir(project))).toHaveLength(1);
    const { document } = readOnlyEntry(project);
    expect(document.schemaVersion).toBe('trace-1');
    expect(document.payload.actions).toHaveLength(2);
    expect(document.payload.executor.name).toBe('two-tap-executor');
    expect(document.payload.startPath).toBe('/');
    // The recording's own check, kept as data: the counter reading 2 appeared
    // during the step, so a replay must show it again before passing alone.
    expect(document.payload.endAnchors).toContainEqual({ role: 'status', name: 'Counter', text: '2' });
  });

  it('replays the second run zero-turn without invoking the executor', () => {
    expect(secondRun.exitCode).toBe(0);
    expect(second.calls).toBe(0);
    const step = actStep(secondRun);
    expect(step.status).toBe('passed');
    expect(step.cache).toEqual({
      mode: 'self-finalized',
      replayedActions: 2,
      totalActions: 2,
    });
    expect(step.metrics!.modelCalls).toBe(0);
    expect(step.metrics!.actionSteps).toBe(2);
    expect(step.explanation).toContain('zero-turn');
    // The re-staged entry keeps the ORIGINAL verdict prose and its
    // postcondition — a summary that nested the replay wrapper would grow on
    // every run until the bound truncated it.
    const { document } = readOnlyEntry(project);
    expect(document.payload.summary).toBe('the counter shows 2');
    expect(document.payload.summary).not.toContain('recorded verdict');
    expect(document.payload.endPath).toBe('/');
  });

  it('emits schema-valid reports for both cached and uncached runs', () => {
    const report = JSON.parse(
      readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8'),
    ) as object;
    assertValidReport(report);
  });
});

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
        agent: twoTapExecutor(record),
        cache: 'read-write' as const,
      },
    });
    await runExisting(project, options(first));
    // Sabotage the second recorded action's descriptor: relocation must fail
    // there, after the first action already replayed against the live page.
    const { file, document } = readOnlyEntry(project);
    document.payload.actions[1].target.name = 'No Such Button';
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');
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
    expect(step.cache).toEqual({
      mode: 'agent-concluded',
      reason: 'target-not-found',
      replayedActions: 1,
      totalActions: 2,
    });
  });

  it('rewrites the entry on pass, healing the sabotaged descriptor', () => {
    const { document } = readOnlyEntry(project);
    expect(document.payload.actions[1].target.name).toBe('Increment');
  });
});

const WRONG_EXPECT_SUITE = `import { test, expect } from '@e2edev/e2e';

test('cached step increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('3');
});
`;

const WRONG_EXPECT_WITH_TEARDOWN_SUITE = `import { test, expect } from '@e2edev/e2e';

test.afterEach(async ({ app }) => {
  await app.open();
});

test('cached step increments twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status')).toHaveText('3');
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
        agent: twoTapExecutor(record),
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

  it('never writes a trace whose following assertion failed', async () => {
    project = createProject({ 'tests/act.e2e.ts': WRONG_EXPECT_SUITE });
    const outcome = await runExisting(project, options());
    expect(outcome.exitCode).not.toBe(0);
    // The act passed (the executor saw 2), the expect demanded 3: the staged
    // trace is unconfirmed and nothing may reach the store.
    expect(existsSync(cacheDir(project))).toBe(false);
    project.cleanup();
  }, 120_000);

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

const STORAGE_SUITE = `import { test, expect } from '@e2edev/e2e';

test('saves the marker', async ({ app, agent, screen }) => {
  await app.open('/storage');
  await agent.act('save the marker');
  await expect(screen.getByLabel('Marker')).toHaveText('saved');
});
`;

/**
 * Taps "Save marker" once (unless a replayed prefix already did) and checks
 * the marker. With `repair`, an end-mismatch hand-off makes it tap again — the
 * shape of an executor that found the replayed flow had not taken effect.
 */
function saveMarkerExecutor(record: ExecutorRecord, options: { repair?: boolean } = {}): StepExecutor {
  return {
    name: 'save-marker-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      let observation = await context.observe();
      const prefix = context.replayedPrefix;
      const mustAct =
        (prefix?.replayedActions.length ?? 0) === 0 ||
        (options.repair === true && prefix?.stopReason === 'end-mismatch');
      if (mustAct) {
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

  const options = (executor: { repair?: boolean } = {}) => {
    const record: ExecutorRecord = { calls: 0, prefixes: [] };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agent: saveMarkerExecutor(record, executor),
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
    const { document } = readOnlyEntry(project);
    expect(document.payload.startPath).toBe('/storage');
    expect(document.payload.endPath).toBe('/storage');
    expect(document.payload.endAnchors).toContainEqual({ role: 'status', name: 'Marker', text: 'saved' });

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(0);
    const step = resultByTitle(second, 'saves the marker').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
  }, 240_000);

  it('hands off with end-mismatch when the recorded effect is not on screen after a full replay', async () => {
    // Every recorded action still replays; only the recorded end state is
    // made unreachable. Mechanics alone must not pass the step.
    const { file, document } = readOnlyEntry(project);
    document.payload.endAnchors = [{ role: 'status', name: 'Marker', text: 'never-saved' }];
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');

    const outcome = await runExisting(project, options());
    expect(outcome.exitCode).toBe(0);
    const record = records.at(-1)!;
    expect(record.calls).toBe(1);
    expect(record.prefixes[0]).toMatchObject({
      stopReason: 'end-mismatch',
      replayedActions: ['tap button "Save marker"'],
      totalActions: 1,
    });
    const step = resultByTitle(outcome, 'saves the marker').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toEqual({
      mode: 'agent-concluded',
      reason: 'end-mismatch',
      replayedActions: 1,
      totalActions: 1,
    });
    // The executor's pass re-stages the entry with the live anchors: healed.
    expect(readOnlyEntry(project).document.payload.endAnchors).toContainEqual({
      role: 'status',
      name: 'Marker',
      text: 'saved',
    });
  }, 240_000);

  it('evicts the entry when the executor had to act again after an end-mismatch', async () => {
    const { file, document } = readOnlyEntry(project);
    document.payload.endAnchors = [{ role: 'status', name: 'Marker', text: 'never-saved' }];
    writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');

    const outcome = await runExisting(project, options({ repair: true }));
    expect(outcome.exitCode).toBe(0);
    const record = records.at(-1)!;
    expect(record.prefixes[0]?.stopReason).toBe('end-mismatch');
    // The replayed flow plus its repair is not a flow worth replaying: the
    // entry is gone, and the next passing run records a clean one.
    expect(readdirSync(cacheDir(project)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  }, 240_000);
});

const TRAILING_ACT_SUITE = `import { test } from '@e2edev/e2e';

test('cached step increments twice', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment the counter twice');
});
`;

describe('trace cache: only a verification step confirms a write', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('never writes the trace of a trailing act nothing asserted on, even though the attempt passed', async () => {
    const project = createProject({ 'tests/act.e2e.ts': TRAILING_ACT_SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agent: twoTapExecutor(record),
          cache: 'read-write' as const,
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(record.calls).toBe(1);
      expect(existsSync(cacheDir(project))).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

const TOOLS_ONLY_SUITE = `import { test } from '@e2edev/e2e';

test('tools-only step', async ({ agent }) => {
  await agent.act('do the work with your own tools');
});
`;

/** Never observes, never acts: the shape of an executor that only uses its own tools. */
function toolsOnlyExecutor(record: ExecutorRecord): StepExecutor {
  return {
    name: 'tools-only-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      record.prefixes.push(context.replayedPrefix);
      return { status: 'passed' as const, summary: 'done without the screen' };
    },
  };
}

describe('trace cache: a backend-independent executor is not gated by the cache', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('runs the executor with caching on, without an opened app, and stages nothing', async () => {
    const project = createProject({ 'tests/tools.e2e.ts': TOOLS_ONLY_SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          agent: toolsOnlyExecutor(record),
          cache: 'read-write' as const,
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(record.calls).toBe(1);
      expect(record.prefixes).toEqual([undefined]);
      expect(existsSync(cacheDir(project))).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('trace cache: modes that never write', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('caches by default: a config without a cache key records entries', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: twoTapExecutor(record),
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(readdirSync(cacheDir(project))).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('--no-cache overrides the config and runs fully uncached', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: twoTapExecutor(record),
          cache: 'read-write' as const,
        },
        runOptions: { noCache: true },
      });
      expect(outcome.exitCode).toBe(0);
      expect(record.calls).toBe(1);
      expect(existsSync(cacheDir(project))).toBe(false);
      const step = actStep(outcome);
      expect(step.cache).toBeUndefined();
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('read-only mode never creates the store', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: twoTapExecutor(record),
          cache: 'read-only' as const,
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(record.calls).toBe(1);
      expect(existsSync(cacheDir(project))).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('CI demotes an unset cache mode to read-only', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: twoTapExecutor(record),
        },
        runOptions: {
          env: { ...process.env, APP_URL: app.url, CI: '1' },
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(cacheDir(project))).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('CI honors an explicit read-write as the project stating its trust', async () => {
    const project = createProject({ 'tests/act.e2e.ts': SUITE });
    try {
      const record: ExecutorRecord = { calls: 0, prefixes: [] };
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: twoTapExecutor(record),
          cache: 'read-write' as const,
        },
        runOptions: {
          env: { ...process.env, APP_URL: app.url, CI: '1' },
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(cacheDir(project))).toBe(true);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
