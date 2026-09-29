/**
 * Record and replay of `agent.act()` steps through the real browser engine,
 * driven by a scripted tool-calling model: the first run records each flow,
 * the second replays it with no model call, and every promise `docs/cache.mdx`
 * makes about what replays, what relocates, what invalidates an entry, and what
 * an entry may hold is checked against the report and the entry files.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TraceEntry } from '../../src/cache/trace.ts';
import { main } from '../../src/cli/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import { loopCalls } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, webTarget, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import {
  actSteps,
  cacheConfig,
  entriesFor,
  expectMissed,
  expectPassed,
  expectReplayed,
  flowByTitle,
  FLOWS,
  flowsModel,
  flowsSuite,
  handedOffNotice,
  onlyActStep,
  readEntries,
  type Flow,
} from '../helpers/trace-cache.ts';

const FLOWS_FILE = 'tests/flows.e2e.ts';

/** One entry per act step every flow makes. */
const ENTRY_COUNT = FLOWS.reduce((total, flow) => total + flow.actions.length, 0);

describe('trace cache: every flow records on the first run and replays without a model on the second', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let recordedModelCalls = 0;
  /** The archive entry as the first run wrote it; the second run opens the record under another id. */
  let recordedArchive: TraceEntry | undefined;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: flowsSuite(FLOWS, 'record') });
    recorded = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) });
    recordedModelCalls = loopCalls.length;
    [recordedArchive] = entriesFor(project, 'archives a record');
    writeFileSync(path.join(project.dir, FLOWS_FILE), flowsSuite(FLOWS, 'replay'), 'utf8');
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes every flow on both runs', () => {
    expectPassed(recorded);
    expectPassed(replayed);
  });

  it('misses every step on the first run and writes one entry per act step', () => {
    expect(recordedModelCalls).toBeGreaterThan(0);
    for (const flow of FLOWS) {
      const steps = actSteps(recorded, flow.title);
      expect(steps, flow.title).toHaveLength(flow.actions.length);
      for (const step of steps) {
        expect(step.cache, flow.title).toMatchObject({ mode: 'missed', reason: 'no-entry', replayedActions: 0 });
        expect(step.metrics?.modelCalls, flow.title).toBeGreaterThan(0);
      }
      expect(entriesFor(project, flow.title), flow.title).toHaveLength(flow.actions.length);
    }
    expect(readEntries(project)).toHaveLength(ENTRY_COUNT);
  });

  it('replays every step on the second run with zero model calls across the whole run', () => {
    expect(loopCalls).toHaveLength(0);
    for (const flow of FLOWS) {
      const steps = actSteps(replayed, flow.title);
      expect(steps.map((step) => step.cache?.totalActions), flow.title).toEqual(flow.actions);
      for (const [index, step] of steps.entries()) expectReplayed(step, flow.actions[index]!);
    }
    expect(readEntries(project)).toHaveLength(ENTRY_COUNT);
  });

  it('keeps a unique() value as a slot in the typed text, the percent-encoded path, and the anchors', () => {
    const [entry] = entriesFor(project, 'creates a company');
    const { payload } = entry!;
    expect(payload.actions.map((action) => action.name)).toEqual(['type', 'tap']);
    expect(payload.actions[0]).toMatchObject({ name: 'type', value: '{{param:/name}}' });
    expect(payload.startPath).toBe('/companies/new');
    expect(payload.endPath).toBe('/companies/{{param:/name|uri}}');
    expect(payload.endAnchors).toContainEqual({ role: 'heading', name: '{{param:/name}}' });
    expect(JSON.stringify(entry)).not.toMatch(/E2E \d+ Company/u);
  });

  it('spells a unique() value in a query string the way the form submission did', () => {
    const [entry] = entriesFor(project, 'searches');
    const { payload } = entry!;
    expect(payload.endPath).toBe('/search?q={{param:/q|form}}');
    expect(payload.endAnchors).toContainEqual({ role: 'heading', name: 'Results for {{param:/q}}' });
    expect(JSON.stringify(entry)).not.toMatch(/E2E[ +]\d+[ +]widget/u);
  });

  it('records no anchor made of a result count, a millisecond timing, or a bare badge number', () => {
    const [entry] = entriesFor(project, 'searches');
    const anchors = entry!.payload.endAnchors ?? [];
    expect(anchors).toContainEqual({ role: 'status', name: 'Search state', text: 'done' });
    for (const anchor of anchors) {
      for (const text of [anchor.name, anchor.text]) {
        if (text === undefined) continue;
        expect(text, JSON.stringify(anchor)).not.toMatch(/\d+ results/u);
        expect(text, JSON.stringify(anchor)).not.toMatch(/\d+ms/u);
        expect(text, JSON.stringify(anchor)).not.toMatch(/^\d+$/u);
      }
    }
  });

  it('records the start path with the minted id the recording run opened; a replay under another id leaves the entry as recorded', () => {
    expect(recordedArchive!.payload.startPath).toBe('/records/1a2b3c4d5e6f');
    expect(recordedArchive!.payload.endAnchors).toContainEqual({ role: 'status', name: 'Record state', text: 'archived' });
    const [afterReplay] = entriesFor(project, 'archives a record');
    expect(afterReplay!.payload).toEqual(recordedArchive!.payload);
  });

  it('records a placeholder-named field, unnamed twins by their place, and same-named buttons by position', () => {
    const [entry] = entriesFor(project, 'fills the twins form');
    const targets = entry!.payload.actions.map((action) => ('target' in action ? action.target : undefined));
    expect(targets[0]).toMatchObject({ role: 'textbox', name: 'Nickname', placeholder: 'Nickname' });
    expect(targets[2]).toMatchObject({ role: 'textbox', position: { index: 0, of: 2 } });
    expect(targets[3]).toMatchObject({ role: 'textbox', position: { index: 1, of: 2 } });
    for (const anonymous of [targets[2], targets[3]]) {
      expect(anonymous?.name).toBeUndefined();
      expect(anonymous?.placeholder).toBeUndefined();
    }
    expect(targets[4]).toMatchObject({ role: 'button', name: 'Add', position: { index: 1, of: 3 } });
  });

  it('records a repeated control by the row it sits in', () => {
    const [entry] = entriesFor(project, 'reserves offer B');
    expect(entry!.payload.actions[0]).toMatchObject({ name: 'tap', target: { role: 'button', name: 'Reserve now', within: 'Offer B' } });
  });

  it('keeps the two entries of the mixed test apart and re-stages both after the replay', () => {
    const entries = entriesFor(project, 'mixes deterministic and agent steps');
    const anchors = entries.map((entry) => entry.payload.endAnchors?.find((anchor) => anchor.name === 'Counter')?.text).toSorted();
    expect(anchors).toEqual(['1', '3']);
  });
});

const company = flowByTitle('creates a company');
const archives = flowByTitle('archives a record');

/** The flows whose second run changes the screen under the recording. */
const DIVERGENCE: readonly Flow[] = [
  { ...company, open: (variant) => (variant === 'replay' ? '/companies/new?variant=renamed' : '/companies/new') },
  { ...archives, open: (variant) => (variant === 'replay' ? '/drafts/1a2b3c4d5e6f' : '/records/1a2b3c4d5e6f') },
  {
    ...archives,
    title: 'retires a record',
    open: (variant) => (variant === 'replay' ? '/records/2b3c4d5e6f7a?variant=renamed' : '/records/2b3c4d5e6f7a'),
  },
];

describe('trace cache: a changed screen hands the step to the agent, which re-records it', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: flowsSuite(DIVERGENCE, 'record') });
    expectPassed(await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) }));
    writeFileSync(path.join(project.dir, FLOWS_FILE), flowsSuite(DIVERGENCE, 'replay'), 'utf8');
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes every flow on the second run too', () => {
    expectPassed(replayed);
  });

  it('replays the typing, hands off at the renamed button, and tells the model what already ran', () => {
    const step = onlyActStep(replayed, 'creates a company');
    expect(step.cache).toEqual({ mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1, totalActions: 2 });
    expect(step.metrics?.modelCalls).toBeGreaterThan(0);
    const notice = handedOffNotice(loopCalls);
    expect(notice).toMatch(/target-not-found/u);
    expect(notice).toMatch(/\b1 of 2\b/u);
    const [entry] = entriesFor(project, 'creates a company');
    expect(entry!.payload.actions).toHaveLength(2);
    expect(entry!.payload.actions[1]).toMatchObject({ name: 'tap', target: { name: 'Save' } });
  });

  it('misses with wrong-context on another route and records the new screen', () => {
    const step = onlyActStep(replayed, 'archives a record');
    expectMissed(step, 'wrong-context', 1);
    expect(step.metrics?.modelCalls).toBeGreaterThan(0);
    const [entry] = entriesFor(project, 'archives a record');
    expect(entry!.payload.startPath).toBe('/drafts/1a2b3c4d5e6f');
  });

  it('misses with target-not-found when the first control vanished, and heals the entry', () => {
    const step = onlyActStep(replayed, 'retires a record');
    expectMissed(step, 'target-not-found', 1);
    const [entry] = entriesFor(project, 'retires a record');
    expect(entry!.payload.actions[0]).toMatchObject({ name: 'tap', target: { role: 'button', name: 'Retire' } });
  });
});

describe('trace cache: --strict-cache fails a stale recording instead of handing it to the agent', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let strict: RunOutcome;
  let strictModelCalls = 0;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: flowsSuite(DIVERGENCE, 'record') });
    expectPassed(await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()) }));
    writeFileSync(path.join(project.dir, FLOWS_FILE), flowsSuite(DIVERGENCE, 'replay'), 'utf8');
    strict = await runExisting(project, { appUrl: app.url, config: cacheConfig(flowsModel()), runOptions: { strictCache: true } });
    strictModelCalls = loopCalls.length;
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('fails every diverged step with REPLAY_STALE, exit 2, without a model call or a retry', () => {
    expect(strict.exitCode).toBe(2);
    expect(strictModelCalls).toBe(0);
    for (const [title, reason] of [
      ['creates a company', 'target-not-found'],
      ['archives a record', 'wrong-context'],
      ['retires a record', 'target-not-found'],
    ] as const) {
      const step = onlyActStep(strict, title);
      expect(step.error?.code, title).toBe('REPLAY_STALE');
      expect(step.error?.message, title).toContain(reason);
      expect(step.error?.message, title).toContain('re-record it with a read-write run without --strict-cache and commit the changed entry under .e2e/cache');
      expect(step.cache?.reason, title).toBe(reason);
    }
  });
});

/** The one-flow suite the target and repeat suites run: the counter, incremented twice. */
const COUNTER_SUITE = flowsSuite([flowByTitle('increments the counter')], 'record');

/** Runs `e2e cache <command>` against the project, returning what it printed. */
async function cacheCli(project: FixtureProject, command: 'ls' | 'stats'): Promise<string> {
  writeFileSync(
    path.join(project.dir, 'e2e.config.ts'),
    "export default { targets: [{ name: 'web', platform: 'web' }] };\n",
    'utf8',
  );
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await main(['node', 'e2e', 'cache', command, '--config', path.join(project.dir, 'e2e.config.ts')]);
    return stripVTControlCharacters(stdout.mock.calls.map((call) => String(call[0])).join(''));
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  }
}

describe('trace cache: two targets keep separate entries', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  const twoTargets = (): E2EConfig => ({
    ...cacheConfig(flowsModel()),
    targets: [webTarget('web', app.url), webTarget('web-b', app.url)],
  });

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records one entry per target and lists both', async () => {
    const outcome = await runExisting(project, { appUrl: app.url, config: twoTargets() });
    expectPassed(outcome);
    expect(outcome.results.map((result) => result.target.name).toSorted()).toEqual(['web', 'web-b']);
    const entries = readEntries(project);
    expect(entries.map(({ entry }) => entry.payload.recordedFor?.targetId).toSorted()).toEqual(['web', 'web-b']);
    const listing = await cacheCli(project, 'ls');
    expect(listing).toMatch(/increments%20the%20counter\s+web\s+/u);
    expect(listing).toMatch(/increments%20the%20counter\s+web-b\s+/u);
  }, 120_000);

  it('replays on both targets without a model call', async () => {
    const outcome = await runExisting(project, { appUrl: app.url, config: twoTargets() });
    expectPassed(outcome);
    expect(loopCalls).toHaveLength(0);
    for (const result of outcome.results) {
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expectReplayed(step, 2);
    }
  }, 120_000);
});

describe('trace cache: --repeat-each records on the first repeat and replays on the second', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('serves the second repeat from the entry the first one confirmed', async () => {
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: cacheConfig(flowsModel()),
      runOptions: { repeatEach: 2 },
    });
    expectPassed(outcome);
    expect(outcome.results).toHaveLength(2);
    expectMissed(onlyActStep(outcome, 'increments the counter', 0), 'no-entry', 0);
    expectReplayed(onlyActStep(outcome, 'increments the counter', 1), 2);
    expect(readEntries(project)).toHaveLength(1);
  }, 120_000);
});
