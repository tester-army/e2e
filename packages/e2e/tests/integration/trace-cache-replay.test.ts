/**
 * Record and replay of `agent.act()` steps through the real browser engine,
 * driven by a scripted tool-calling model: the first run records each flow,
 * the second replays it with no model call, and every promise `docs/cache.mdx`
 * makes about what replays, what relocates, what invalidates an entry, and what
 * an entry may hold is checked against the report and the entry files.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { web } from '@e2edev/web';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import type { EngineHandle } from '../../src/engine/index.ts';
import type { RecordedAction, TraceEntry } from '../../src/cache/trace.ts';
import { main } from '../../src/cli/index.ts';
import type { E2EConfig, ModelInstance } from '../../src/index.ts';
import type { StepRecord } from '../../src/run/steps.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall, type LoopToolCall } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const PASSWORD = 'replay-secret-Zq9#"&=4242';

/** The entry files under the project's store, parsed. */
function readEntries(project: FixtureProject): { readonly file: string; readonly entry: TraceEntry }[] {
  const dir = path.join(project.dir, '.e2e', 'cache');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .map((name) => {
      const file = path.join(dir, name);
      return { file, entry: JSON.parse(readFileSync(file, 'utf8')) as TraceEntry };
    });
}

/** The entries recorded for one test, by the title its id carries, in file order. */
function entriesFor(project: FixtureProject, title: string): TraceEntry[] {
  return readEntries(project)
    .map(({ entry }) => entry)
    .filter((entry) => {
      const testId = entry.payload.recordedFor?.testId ?? '';
      return decodeURIComponent(testId.slice(testId.indexOf('::') + 2)) === title;
    });
}

/** The agent steps of one test's last attempt, in order. */
function actSteps(outcome: RunOutcome, title: string, repeat = 0): StepRecord[] {
  const result = outcome.results.find((candidate) => candidate.test.title === title && candidate.repeat === repeat);
  if (result === undefined) {
    throw new Error(
      `no result titled "${title}" (repeat ${String(repeat)}); got: ${outcome.results.map((r) => `${r.test.title}#${String(r.repeat)}`).join(', ')}; run errors: ${JSON.stringify(outcome.report.run.errors)}`,
    );
  }
  return result.attempts.at(-1)!.steps.filter((step) => step.api === 'agent.act');
}

/** The one agent step of a test, failing when the test has another number of them. */
function onlyActStep(outcome: RunOutcome, title: string, repeat = 0): StepRecord {
  const steps = actSteps(outcome, title, repeat);
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

/** Fails with the attempt errors when a run did not pass, so a broken flow names itself. */
function expectPassed(outcome: RunOutcome): void {
  const failures = outcome.results.flatMap((result) =>
    result.attempts.flatMap((attempt) => (attempt.error === undefined ? [] : [`${result.test.title}: ${attempt.error.message}`])),
  );
  expect(failures, JSON.stringify(outcome.report.run.errors)).toEqual([]);
  expect(outcome.exitCode).toBe(0);
}

/** A step the cache served whole: no model turn, the recorded verdict as its explanation. */
function expectReplayed(step: StepRecord, actions: number): void {
  expect(step.status).toBe('passed');
  expect(step.cache).toEqual({ mode: 'self-finalized', replayedActions: actions, totalActions: actions });
  expect(step.metrics?.modelCalls).toBe(0);
  expect(step.explanation).toContain('zero-turn');
}

/** A step the executor ran from the top, with the reason the report gives. */
function expectMissed(step: StepRecord, reason: string, totalActions: number): void {
  expect(step.cache).toEqual({ mode: 'missed', reason, replayedActions: 0, totalActions });
}

/** The parameters of the step the prompt carries, as the model reads them. */
function paramsOf(call: LoopCall): Record<string, string> {
  const json = /^Step parameters:\n(.*)$/mu.exec(call.prompt)?.[1];
  return json === undefined ? {} : (JSON.parse(json) as Record<string, string>);
}

/** The instruction the prompt opens with. */
function instructionOf(call: LoopCall): string {
  return /^Execute this test step: (.*)$/mu.exec(call.prompt)?.[1] ?? '';
}

/** Node ids of the textboxes the screen lists with no name, in document order. */
function anonymousTextboxes(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => /^\s*#\S+ textbox\s*$/u.test(line))
    .map((line) => /#(\S+)/u.exec(line)![1]!);
}

/** Node ids of every line matching the pattern, in document order. */
function nodeIdsFor(prompt: string, pattern: RegExp): string[] {
  return prompt
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => /#(\S+)/u.exec(line)![1]!);
}

/** The "Reserve now" button in the row whose label is `offer`. */
function reserveButtonFor(prompt: string, offer: string): string {
  const lines = prompt.split('\n');
  const row = lines.findIndex((line) => line.includes(`text="Offer ${offer}"`));
  const button = lines.slice(row + 1).find((line) => line.includes('button "Reserve now"'));
  return /#(\S+)/u.exec(button!)![1]!;
}

/** One `tap` tool call on a node id. */
const tap = (target: string): LoopToolCall => ({ toolName: 'tap', input: { target } });
/** One `type` tool call: `value` into the node. */
const type = (target: string, value: string): LoopToolCall => ({ toolName: 'type', input: { target, value } });
/** The passing `complete_step` verdict. */
const passed = (summary: string): LoopToolCall[] => [{ toolName: 'complete_step', input: { status: 'passed', summary } }];

/** One scripted flow: how to act on its opening screen, and what the screen shows once it is done. */
interface ScriptedFlow {
  readonly act: (call: LoopCall) => LoopToolCall[];
  readonly done: RegExp;
}

/**
 * Every flow the suites below ask for, keyed by instruction. A flow acts in
 * one batched turn and concludes on the next once its end state is on
 * screen. After a partial replay the prompt carries the hand-off notice, and
 * the company flow resumes after the typing the replay already did.
 */
const incrementTwice: ScriptedFlow = {
  act: (call) => {
    const id = nodeIdFor(call.prompt, /button "Increment"/u);
    return [tap(id), tap(id)];
  },
  done: /"Counter" text="2"/u,
};

const FLOWS: Readonly<Record<string, ScriptedFlow>> = {
  'increment the counter twice': incrementTwice,
  'increment the counter two times': incrementTwice,
  'increment the counter once': {
    act: (call) => [tap(nodeIdFor(call.prompt, /button "Increment"/u))],
    done: /"Counter" text="1"/u,
  },
  'increment the counter one more time': {
    act: (call) => [tap(nodeIdFor(call.prompt, /button "Increment"/u))],
    done: /"Counter" text="3"/u,
  },
  'create a company named {name}': {
    act: (call) => {
      const submit = tap(nodeIdFor(call.prompt, /button "(Create|Save)"/u));
      if (call.prompt.includes('Replay stopped')) return [submit];
      return [type(nodeIdFor(call.prompt, /textbox "Company name"/u), paramsOf(call)['name']!), submit];
    },
    done: /"Company state" text="created"/u,
  },
  'search for {q}': {
    act: (call) => [type(nodeIdFor(call.prompt, /textbox "Query"/u), paramsOf(call)['q']!), tap(nodeIdFor(call.prompt, /button "Search"/u))],
    done: /"Search state" text="done"/u,
  },
  'archive this record': {
    act: (call) => [tap(nodeIdFor(call.prompt, /button "(Archive|Retire)"/u))],
    done: /"Record state" text="archived"/u,
  },
  'refresh the feed': {
    act: (call) => [tap(nodeIdFor(call.prompt, /button "Refresh feed"/u))],
    done: /"Marker" text="refreshed"/u,
  },
  'fill in the twins form': {
    act: (call) => {
      const [first, second] = anonymousTextboxes(call.prompt);
      const adds = nodeIdsFor(call.prompt, /button "Add"/u);
      return [
        type(nodeIdFor(call.prompt, /textbox "Nickname"/u), 'ada'),
        type(nodeIdFor(call.prompt, /textbox "Motto"/u), 'carpe diem'),
        type(first!, 'quill'),
        type(second!, 'ember'),
        tap(adds[1]!),
        tap(nodeIdFor(call.prompt, /button "Submit"/u)),
      ];
    },
    done: /"Summary" text="nickname=ada/u,
  },
  'reserve offer B': {
    act: (call) => [tap(reserveButtonFor(call.prompt, 'B'))],
    done: /"Picked" text="B"/u,
  },
  'enter the password': {
    act: (call) => [{ toolName: 'type_secret', input: { target: nodeIdFor(call.prompt, /textbox "Password"/u), name: 'member' } }],
    done: /Filled secret "member"/u,
  },
  'add a todo for groceries': {
    act: (call) => [type(nodeIdFor(call.prompt, /textbox "New todo"/u), 'Buy milk'), tap(nodeIdFor(call.prompt, /button "Add"/u))],
    done: /"Todo state" text="added"/u,
  },
};

/** The scripted model behind every suite here; a flow it was not given fails the step loudly. */
function flowsModel(): ModelInstance {
  return installFakeLoopModel((call) => {
    const instruction = instructionOf(call);
    const flow = FLOWS[instruction];
    if (flow === undefined) throw new Error(`unscripted instruction: ${instruction}`);
    if (flow.done.test(call.lastToolResult)) return passed(`done: ${instruction}`);
    if (call.lastToolResult !== '') throw new Error(`"${instruction}" did not reach its end state:\n${call.lastToolResult}`);
    return flow.act(call);
  });
}

type Variant = 'record' | 'replay';

/**
 * Nine flows, one recording each (the mixed test records two). The replay
 * variant opens the same screens under the shapes a second visit takes: a
 * fresh record id, reordered rows, a banner pushed in above the form.
 */
function flowsSuite(variant: Variant): string {
  const replay = variant === 'replay';
  return `import { test, expect, credentials, unique } from 'e2e';

test('increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});

test('creates a company', async ({ app, agent, screen }) => {
  await app.open('/companies/new');
  const name = 'E2E ' + String(Date.now()) + ' Company';
  await agent.act('create a company named {name}', { params: { name: unique(name) } });
  await expect(screen.getByRole('heading', { name })).toBeVisible();
});

test('searches', async ({ app, agent, screen }) => {
  await app.open('/search');
  const q = 'E2E ' + String(Date.now()) + ' widget';
  await agent.act('search for {q}', { params: { q: unique(q) } });
  await expect(screen.getByRole('heading', { name: 'Results for ' + q })).toBeVisible();
});

test('archives a record', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(replay ? '/records/9f8e7d6c5b4a' : '/records/1a2b3c4d5e6f')});
  await agent.act('archive this record');
  await expect(screen.getByRole('status', { name: 'Record state' })).toHaveText('archived');
});

test('refreshes the feed', async ({ app, agent, screen }) => {
  await app.open('/feed');
  await agent.act('refresh the feed');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('refreshed');
});

test('fills the twins form', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(replay ? '/twins-form?variant=b' : '/twins-form')});
  await agent.act('fill in the twins form');
  await expect(screen.getByRole('status', { name: 'Summary' })).toHaveText('nickname=ada motto=carpe diem first=quill second=ember picked=2');
});

test('reserves offer B', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(replay ? '/repeats?reverse=1' : '/repeats')});
  await agent.act('reserve offer B');
  await expect(screen.getByRole('status', { name: 'Picked' })).toHaveText('B');
});

test('mixes deterministic and agent steps', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
  await screen.getByRole('button', { name: 'Increment' }).click();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
  await agent.act('increment the counter one more time');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('3');
});

test('enters the password', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('enter the password', { params: { password: credentials.user('member').password } });
  await expect(screen.getByLabel('Password')).toBeVisible();
});
`;
}

const FLOW_TITLES = [
  'increments the counter',
  'creates a company',
  'searches',
  'archives a record',
  'refreshes the feed',
  'fills the twins form',
  'reserves offer B',
  'mixes deterministic and agent steps',
  'enters the password',
] as const;

const FLOWS_FILE = 'tests/flows.e2e.ts';

/** The config every suite here runs with: the scripted model, a read-write cache, one declared credential. */
function flowsConfig(model: ModelInstance): E2EConfig {
  return {
    tests: 'tests/**/*.e2e.ts',
    agents: { default: { model } },
    cache: 'read-write',
    credentials: { member: { username: 'ada', password: PASSWORD } },
  };
}

describe('trace cache: nine flows record on the first run and replay without a model on the second', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let recordedModelCalls = 0;
  /** The entries as the first run wrote them; the second run re-stages every one it replays. */
  let recordedEntries: TraceEntry[] = [];
  let replayed: RunOutcome;

  /** The entries the first run recorded for one test. */
  const recordedFor = (title: string): TraceEntry[] =>
    recordedEntries.filter((entry) => {
      const testId = entry.payload.recordedFor?.testId ?? '';
      return decodeURIComponent(testId.slice(testId.indexOf('::') + 2)) === title;
    });

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: flowsSuite('record') });
    recorded = await runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()) });
    recordedModelCalls = loopCalls.length;
    recordedEntries = readEntries(project).map(({ entry }) => entry);
    writeFileSync(path.join(project.dir, FLOWS_FILE), flowsSuite('replay'), 'utf8');
    replayed = await runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()) });
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
    for (const title of FLOW_TITLES) {
      for (const step of actSteps(recorded, title)) {
        expect(step.cache, title).toMatchObject({ mode: 'missed', reason: 'no-entry', replayedActions: 0 });
        expect(step.metrics?.modelCalls, title).toBeGreaterThan(0);
      }
    }
    expect(readEntries(project)).toHaveLength(10);
    expect(entriesFor(project, 'mixes deterministic and agent steps')).toHaveLength(2);
  });

  it('replays every step on the second run with zero model calls across the whole run', () => {
    expect(loopCalls).toHaveLength(0);
    const actions: Record<(typeof FLOW_TITLES)[number], number[]> = {
      'increments the counter': [2],
      'creates a company': [2],
      searches: [2],
      'archives a record': [1],
      'refreshes the feed': [1],
      'fills the twins form': [6],
      'reserves offer B': [1],
      'mixes deterministic and agent steps': [1, 1],
      'enters the password': [1],
    };
    for (const title of FLOW_TITLES) {
      const steps = actSteps(replayed, title);
      expect(steps.map((step) => step.cache?.totalActions), title).toEqual(actions[title]);
      for (const [index, step] of steps.entries()) expectReplayed(step, actions[title][index]!);
    }
    expect(readEntries(project)).toHaveLength(10);
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

  it('records the start path with the minted id the recording run opened, and re-stages it with the replay\'s', () => {
    const [entry] = recordedFor('archives a record');
    expect(entry!.payload.startPath).toBe('/records/1a2b3c4d5e6f');
    expect(entry!.payload.endAnchors).toContainEqual({ role: 'status', name: 'Record state', text: 'archived' });
    const [restaged] = entriesFor(project, 'archives a record');
    expect(restaged!.payload.startPath).toBe('/records/9f8e7d6c5b4a');
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

  it('stores a secret fill by name only; the plaintext is nowhere in the store', () => {
    const [entry] = entriesFor(project, 'enters the password');
    expect(entry!.payload.actions).toEqual([
      { name: 'typeSecret', summary: expect.stringContaining('member'), target: expect.objectContaining({ role: 'textbox', name: 'Password' }), secret: 'member' },
    ]);
    for (const { file } of readEntries(project)) {
      expect(readFileSync(file).includes(PASSWORD), file).toBe(false);
    }
    expect(JSON.stringify(recorded.report)).not.toContain(PASSWORD);
    expect(JSON.stringify(replayed.report)).not.toContain(PASSWORD);
  });

  it('keeps the two entries of the mixed test apart and re-stages both after the replay', () => {
    const entries = entriesFor(project, 'mixes deterministic and agent steps');
    const anchors = entries.map((entry) => entry.payload.endAnchors?.find((anchor) => anchor.name === 'Counter')?.text).toSorted();
    expect(anchors).toEqual(['1', '3']);
  });
});

/** Two flows whose second run changes the screen under the recording. */
const DIVERGENCE_SUITE = (variant: Variant): string => `import { test, expect, unique } from 'e2e';

test('creates a company', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(variant === 'replay' ? '/companies/new?variant=renamed' : '/companies/new')});
  const name = 'E2E ' + String(Date.now()) + ' Company';
  await agent.act('create a company named {name}', { params: { name: unique(name) } });
  await expect(screen.getByRole('heading', { name })).toBeVisible();
});

test('archives a record', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(variant === 'replay' ? '/drafts/1a2b3c4d5e6f' : '/records/1a2b3c4d5e6f')});
  await agent.act('archive this record');
  await expect(screen.getByRole('status', { name: 'Record state' })).toHaveText('archived');
});

test('retires a record', async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(variant === 'replay' ? '/records/2b3c4d5e6f7a?variant=renamed' : '/records/2b3c4d5e6f7a')});
  await agent.act('archive this record');
  await expect(screen.getByRole('status', { name: 'Record state' })).toHaveText('archived');
});
`;

describe('trace cache: a changed screen hands the step to the agent, which re-records it', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: DIVERGENCE_SUITE('record') });
    expectPassed(await runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()) }));
    writeFileSync(path.join(project.dir, FLOWS_FILE), DIVERGENCE_SUITE('replay'), 'utf8');
    replayed = await runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()) });
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
    expect(loopCalls.some((call) => call.prompt.includes('Replay stopped (target-not-found) after 1 of 2 recorded actions'))).toBe(true);
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

const COUNTER_SUITE = (instruction: string, params = ''): string => `import { test, expect } from 'e2e';

test('increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act(${JSON.stringify(instruction)}${params});
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});
`;

/** The web engine handle with another version, everything else as built. */
function engineWithVersion(appUrl: string, version: string): EngineHandle {
  const handle = web({ url: appUrl });
  return { ...handle, version } as unknown as EngineHandle;
}

describe('trace cache: what re-keys an entry and what does not', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let engineVersion: string;

  const counterRun = (config: Partial<E2EConfig> = {}): Promise<RunOutcome> =>
    runExisting(project, { appUrl: app.url, config: { ...flowsConfig(flowsModel()), ...config } });

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE('increment the counter twice') });
    engineVersion = (web({ url: app.url }) as unknown as { version: string }).version;
    expectPassed(await counterRun());
    expect(readEntries(project)).toHaveLength(1);
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('a changed instruction is another entry', async () => {
    writeFileSync(path.join(project.dir, FLOWS_FILE), COUNTER_SUITE('increment the counter two times'), 'utf8');
    const outcome = await counterRun();
    expectPassed(outcome);
    expectMissed(onlyActStep(outcome, 'increments the counter'), 'no-entry', 0);
    expect(readEntries(project)).toHaveLength(2);
  }, 120_000);

  it('a changed ordinary param is another entry', async () => {
    writeFileSync(path.join(project.dir, FLOWS_FILE), COUNTER_SUITE('increment the counter twice', ", { params: { style: 'fast' } }"), 'utf8');
    const outcome = await counterRun();
    expectPassed(outcome);
    expectMissed(onlyActStep(outcome, 'increments the counter'), 'no-entry', 0);
    expect(readEntries(project)).toHaveLength(3);
    writeFileSync(path.join(project.dir, FLOWS_FILE), COUNTER_SUITE('increment the counter twice'), 'utf8');
  }, 120_000);

  it('an engine minor bump is another entry; a patch bump replays the same one', async () => {
    const [major, minor, patch] = engineVersion.split('.').map(Number) as [number, number, number];
    const minorBumped = await counterRun({ targets: [{ name: 'web', engine: engineWithVersion(app.url, `${String(major)}.${String(minor + 1)}.0`) }] });
    expectPassed(minorBumped);
    expectMissed(onlyActStep(minorBumped, 'increments the counter'), 'no-entry', 0);
    expect(readEntries(project)).toHaveLength(4);

    const patchBumped = await counterRun({ targets: [{ name: 'web', engine: engineWithVersion(app.url, `${String(major)}.${String(minor)}.${String(patch + 1)}`) }] });
    expectPassed(patchBumped);
    expectReplayed(onlyActStep(patchBumped, 'increments the counter'), 2);
    expect(readEntries(project)).toHaveLength(4);
  }, 120_000);

  it('a renamed target is another entry', async () => {
    const outcome = await counterRun({ targets: [{ name: 'web-renamed', engine: web({ url: app.url }) as never }] });
    expectPassed(outcome);
    expectMissed(onlyActStep(outcome, 'increments the counter'), 'no-entry', 0);
    expect(readEntries(project)).toHaveLength(5);
  }, 120_000);

  it('another model replays the same entry, since the model is not part of the key', async () => {
    const other = { ...flowsModel(), provider: 'other-provider', modelId: 'other-model' } as ModelInstance;
    const outcome = await runExisting(project, { appUrl: app.url, config: { ...flowsConfig(other) } });
    expectPassed(outcome);
    expectReplayed(onlyActStep(outcome, 'increments the counter'), 2);
    expect(loopCalls).toHaveLength(0);
  }, 120_000);
});

/** Taps Increment `taps` times in one step, with no model; the recorder caps the trace at 50. */
function manyTapsExecutor(taps: number, record: { calls: number }): StepExecutor {
  return {
    name: 'many-taps-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      const observation = await context.observe();
      const id = nodeIdFor(observation.text, /button "Increment"/u);
      for (let tapped = 0; tapped < taps; tapped += 1) await context.actions.tap({ id });
      return { status: 'passed', summary: `tapped ${String(taps)} times` };
    },
  };
}

const MANY_TAPS_SUITE = `import { test, expect } from 'e2e';

test('increments the counter many times', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter fifty-one times', { maxSteps: 60 });
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('51');
});
`;

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

describe('trace cache: the action cap truncates the recording, which documents and never replays', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/many.e2e.ts': MANY_TAPS_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('writes a truncated entry of 50 actions, which e2e cache ls flags', async () => {
    const record = { calls: 0 };
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: manyTapsExecutor(51, record), maxSteps: 60 } }, cache: 'read-write' },
    });
    expectPassed(outcome);
    expect(record.calls).toBe(1);
    const [entry] = entriesFor(project, 'increments the counter many times');
    expect(entry!.payload.truncated).toBe(true);
    expect(entry!.payload.actions).toHaveLength(50);
    const listing = await cacheCli(project, 'ls');
    expect(listing).toMatch(/increments%20the%20counter%20many%20times\s+web\s+[a-f0-9]{12}\s+<1m\s+50 \(truncated\)/u);
  }, 120_000);

  it('misses with truncated on the next run and runs the executor from the top', async () => {
    const record = { calls: 0 };
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: manyTapsExecutor(51, record), maxSteps: 60 } }, cache: 'read-write' },
    });
    expectPassed(outcome);
    expect(record.calls).toBe(1);
    expectMissed(onlyActStep(outcome, 'increments the counter many times'), 'truncated', 50);
  }, 120_000);
});

describe('trace cache: --no-cache neither records nor replays', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE('increment the counter twice') });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records nothing with --no-cache, records without it, then leaves the entry untouched with it again', async () => {
    const run = (noCache: boolean) =>
      runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()), runOptions: { noCache } });

    const first = await run(true);
    expectPassed(first);
    expect(onlyActStep(first, 'increments the counter').cache).toBeUndefined();
    expect(loopCalls.length).toBeGreaterThan(0);
    expect(readEntries(project)).toHaveLength(0);

    const second = await run(false);
    expectPassed(second);
    expectMissed(onlyActStep(second, 'increments the counter'), 'no-entry', 0);
    const [written] = readEntries(project);
    expect(written).toBeDefined();
    const before = statSync(written!.file).mtimeMs;

    const third = await run(true);
    expectPassed(third);
    expect(onlyActStep(third, 'increments the counter').cache).toBeUndefined();
    expect(loopCalls.length).toBeGreaterThan(0);
    expect(readEntries(project).map(({ file }) => file)).toEqual([written!.file]);
    expect(statSync(written!.file).mtimeMs).toBe(before);
  }, 180_000);
});

describe('trace cache: two targets keep separate entries', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  const twoTargets = (): E2EConfig => ({
    ...flowsConfig(flowsModel()),
    targets: [
      { name: 'web', engine: web({ url: app.url }) as never },
      { name: 'web-b', engine: web({ url: app.url }) as never },
    ],
  });

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE('increment the counter twice') });
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
    project = createProject({ [FLOWS_FILE]: COUNTER_SUITE('increment the counter twice') });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('serves the second repeat from the entry the first one confirmed', async () => {
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: flowsConfig(flowsModel()),
      runOptions: { repeatEach: 2 },
    });
    expectPassed(outcome);
    expect(outcome.results).toHaveLength(2);
    expectMissed(onlyActStep(outcome, 'increments the counter', 0), 'no-entry', 0);
    expectReplayed(onlyActStep(outcome, 'increments the counter', 1), 2);
    expect(readEntries(project)).toHaveLength(1);
  }, 120_000);
});

const TODOS_SUITE = `import { test, expect } from 'e2e';

test('adds a todo', async ({ app, agent, screen }) => {
  await app.open('/todos-form');
  await agent.act('add a todo for groceries');
  await expect(screen.getByRole('status', { name: 'Todo state' })).toHaveText('added');
});
`;

describe('trace cache: a typed value the model composed is the flow\'s data on every replay', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  const todosRun = (): Promise<RunOutcome> => runExisting(project, { appUrl: app.url, config: flowsConfig(flowsModel()) });

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/todos.e2e.ts': TODOS_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records the composed value as a type action when no screen had shown it', async () => {
    const outcome = await todosRun();
    expectPassed(outcome);
    const [entry] = entriesFor(project, 'adds a todo');
    expect(entry!.payload.actions.map((action: RecordedAction) => action.name)).toEqual(['type', 'tap']);
    expect(entry!.payload.actions[0]).toMatchObject({ name: 'type', value: 'Buy milk' });
  }, 120_000);

  // The app kept the first run's todo, so the second run's opening screen
  // already shows the value the replay is about to type. A replayed type is
  // the flow's own data, never a value read off that screen, so the entry
  // stays intact and the third run replays it too.
  it('replays the typed value on the second run and keeps replaying it on the third', async () => {
    const second = await todosRun();
    expectPassed(second);
    expectReplayed(onlyActStep(second, 'adds a todo'), 2);
    const [afterReplay] = entriesFor(project, 'adds a todo');
    expect(afterReplay!.payload.actions.map((action: RecordedAction) => action.name)).toEqual(['type', 'tap']);

    const third = await todosRun();
    expectPassed(third);
    expectReplayed(onlyActStep(third, 'adds a todo'), 2);
  }, 180_000);
});
