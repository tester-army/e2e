/**
 * What the trace-cache suites share: the flows a scripted model records and
 * replays through the real browser engine, the model that acts them out, the
 * config they run under, and the readers of what a run reported and what the
 * store holds.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import type { TraceEntry } from '../../src/cache/trace.ts';
import type { E2EConfig, ModelInstance } from '../../src/index.ts';
import type { StepCacheInfo, StepRecord } from '../../src/run/steps.ts';
import { installFakeLoopModel, nodeIdFor, type LoopCall, type LoopToolCall } from './fake-loop-model.ts';
import { resultByTitle, type FixtureProject, type RunOutcome } from './run-project.ts';

export type Variant = 'record' | 'replay';

/** How the scripted model acts on a flow's opening screen, and what the screen shows once the flow is done. */
export interface ScriptedFlow {
  readonly act: (call: LoopCall) => LoopToolCall[];
  readonly done: RegExp;
}

/** What a test file needs of a flow: its title, where it opens, and what it does there. */
export interface FlowSource {
  readonly title: string;
  /** The path the test opens under each variant; undefined opens the app's root. */
  readonly open: (variant: Variant) => string | undefined;
  /** The test body after `app.open`: its act steps and the assertions that confirm them. */
  readonly body: string;
}

/** One flow: its test source, the model's part of every act step it makes, and what each step records. */
export interface Flow extends FlowSource {
  /** The model's script for each act step the body makes, keyed by the step's instruction. */
  readonly script: Readonly<Record<string, ScriptedFlow>>;
  /** The actions each act step records, in the body's order. */
  readonly actions: readonly number[];
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

/**
 * The hand-off notice a partial replay puts in the model's prompt, from the
 * first call that carried one.
 */
export function handedOffNotice(calls: readonly LoopCall[]): string {
  for (const call of calls) {
    const notice = /^Replay stopped .*$/mu.exec(call.prompt)?.[0];
    if (notice !== undefined) return notice;
  }
  throw new Error(`no model call carried the hand-off notice; prompts opened with: ${calls.map(instructionOf).join(', ')}`);
}

const tap = (target: string): LoopToolCall => ({ toolName: 'tap', input: { target } });
const type = (target: string, value: string): LoopToolCall => ({ toolName: 'type', input: { target, value } });

const incrementTwice: ScriptedFlow = {
  act: (call) => {
    const id = nodeIdFor(call.prompt, /button "Increment"/u);
    return [tap(id), tap(id)];
  },
  done: /"Counter" text="2"/u,
};

const archive: ScriptedFlow = {
  act: (call) => [tap(nodeIdFor(call.prompt, /button "(Archive|Retire)"/u))],
  done: /"Record state" text="archived"/u,
};

/**
 * The flows the suites record on a first run and replay on a second. Every
 * flow acts in one batched turn and concludes on the next, once its end state
 * is on screen. The replay variant opens the same screens under the shapes a
 * second visit takes: a fresh record id, reordered rows, a banner pushed in
 * above the form. After a partial replay the prompt carries the hand-off
 * notice, and the company flow resumes after the typing the replay already did.
 */
export const FLOWS: readonly Flow[] = [
  {
    title: 'increments the counter',
    open: () => undefined,
    body: `  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');`,
    script: { 'increment the counter twice': incrementTwice },
    actions: [2],
  },
  {
    title: 'creates a company',
    open: () => '/companies/new',
    body: `  const name = 'E2E ' + String(Date.now()) + ' Company';
  await agent.act('create a company named {name}', { params: { name: unique(name) } });
  await expect(screen.getByRole('heading', { name })).toBeVisible();`,
    script: {
      'create a company named {name}': {
        act: (call) => {
          const submit = tap(nodeIdFor(call.prompt, /button "(Create|Save)"/u));
          if (call.prompt.includes('Replay stopped')) return [submit];
          return [type(nodeIdFor(call.prompt, /textbox "Company name"/u), paramsOf(call)['name']!), submit];
        },
        done: /"Company state" text="created"/u,
      },
    },
    actions: [2],
  },
  {
    title: 'searches',
    open: () => '/search',
    body: `  const q = 'E2E ' + String(Date.now()) + ' widget';
  await agent.act('search for {q}', { params: { q: unique(q) } });
  await expect(screen.getByRole('heading', { name: 'Results for ' + q })).toBeVisible();`,
    script: {
      'search for {q}': {
        act: (call) => [type(nodeIdFor(call.prompt, /textbox "Query"/u), paramsOf(call)['q']!), tap(nodeIdFor(call.prompt, /button "Search"/u))],
        done: /"Search state" text="done"/u,
      },
    },
    actions: [2],
  },
  {
    title: 'archives a record',
    open: (variant) => (variant === 'replay' ? '/records/9f8e7d6c5b4a' : '/records/1a2b3c4d5e6f'),
    body: `  await agent.act('archive this record');
  await expect(screen.getByRole('status', { name: 'Record state' })).toHaveText('archived');`,
    script: { 'archive this record': archive },
    actions: [1],
  },
  {
    title: 'refreshes the feed',
    open: () => '/feed',
    body: `  await agent.act('refresh the feed');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('refreshed');`,
    script: {
      'refresh the feed': {
        act: (call) => [tap(nodeIdFor(call.prompt, /button "Refresh feed"/u))],
        done: /"Marker" text="refreshed"/u,
      },
    },
    actions: [1],
  },
  {
    title: 'fills the twins form',
    open: (variant) => (variant === 'replay' ? '/twins-form?variant=b' : '/twins-form'),
    body: `  await agent.act('fill in the twins form');
  await expect(screen.getByRole('status', { name: 'Summary' })).toHaveText('nickname=ada motto=carpe diem first=quill second=ember picked=2');`,
    script: {
      'fill in the twins form': {
        act: (call) => {
          const [first, second] = nodeIdsFor(call.prompt, /^\s*#\S+ textbox\s*$/u);
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
    },
    actions: [6],
  },
  {
    title: 'reserves offer B',
    open: (variant) => (variant === 'replay' ? '/repeats?reverse=1' : '/repeats'),
    body: `  await agent.act('reserve offer B');
  await expect(screen.getByRole('status', { name: 'Picked' })).toHaveText('B');`,
    script: {
      'reserve offer B': {
        act: (call) => [tap(reserveButtonFor(call.prompt, 'B'))],
        done: /"Picked" text="B"/u,
      },
    },
    actions: [1],
  },
  {
    title: 'mixes deterministic and agent steps',
    open: () => undefined,
    body: `  await agent.act('increment the counter once');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
  await screen.getByRole('button', { name: 'Increment' }).click();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
  await agent.act('increment the counter one more time');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('3');`,
    script: {
      'increment the counter once': {
        act: (call) => [tap(nodeIdFor(call.prompt, /button "Increment"/u))],
        done: /"Counter" text="1"/u,
      },
      'increment the counter one more time': {
        act: (call) => [tap(nodeIdFor(call.prompt, /button "Increment"/u))],
        done: /"Counter" text="3"/u,
      },
    },
    actions: [1, 1],
  },
];

/** The flow with this title, failing when the table has none. */
export function flowByTitle(title: string): Flow {
  const flow = FLOWS.find((candidate) => candidate.title === title);
  if (flow === undefined) throw new Error(`no flow titled "${title}"`);
  return flow;
}

/** The source of a test file with one test per flow, each opened under `variant`. */
export function flowsSuite(flows: readonly FlowSource[], variant: Variant): string {
  const tests = flows.map((flow) => {
    const open = flow.open(variant);
    return `test(${JSON.stringify(flow.title)}, async ({ app, agent, screen }) => {
  await app.open(${open === undefined ? '' : JSON.stringify(open)});
${flow.body}
});`;
  });
  return `import { test, expect, unique } from 'e2e';\n\n${tests.join('\n\n')}\n`;
}

/**
 * The scripted model behind the flows: it acts once its screen is the flow's
 * opening one, concludes once the flow's end state is on screen, and fails the
 * step loudly on an instruction no flow scripted or a screen no flow reached.
 */
export function flowsModel(flows: readonly Flow[] = FLOWS): ModelInstance {
  const scripts = new Map(flows.flatMap((flow) => Object.entries(flow.script)));
  return installFakeLoopModel((call) => {
    const instruction = instructionOf(call);
    const flow = scripts.get(instruction);
    if (flow === undefined) throw new Error(`unscripted instruction: ${instruction}`);
    if (flow.done.test(call.lastToolResult)) return [{ toolName: 'complete_step', input: { status: 'passed', summary: `done: ${instruction}` } }];
    if (call.lastToolResult !== '') throw new Error(`"${instruction}" did not reach its end state:\n${call.lastToolResult}`);
    return flow.act(call);
  });
}

/** The config the suites run with: one agent on `model`, a read-write cache, and the target `runExisting` supplies. */
export function cacheConfig(model: ModelInstance): Omit<E2EConfig, 'targets'> {
  return { tests: 'tests/**/*.e2e.ts', agents: { default: { model } }, cache: 'read-write' };
}

/** The entry files under the project's store, parsed, in file order. */
export function readEntries(project: FixtureProject): { readonly file: string; readonly entry: TraceEntry }[] {
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
export function entriesFor(project: FixtureProject, title: string): TraceEntry[] {
  return readEntries(project)
    .map(({ entry }) => entry)
    .filter((entry) => {
      const testId = entry.payload.recordedFor?.testId ?? '';
      return decodeURIComponent(testId.slice(testId.indexOf('::') + 2)) === title;
    });
}

/** The agent steps of one test's last attempt, in order. */
export function actSteps(outcome: RunOutcome, title: string, repeat = 0): StepRecord[] {
  return resultByTitle(outcome, title, repeat).attempts.at(-1)!.steps.filter((step) => step.api === 'agent.act');
}

/** The one agent step of a test, failing when the test has another number of them. */
export function onlyActStep(outcome: RunOutcome, title: string, repeat = 0): StepRecord {
  const steps = actSteps(outcome, title, repeat);
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

/** Fails with the attempt errors when a run did not pass, so a broken flow names itself. */
export function expectPassed(outcome: RunOutcome): void {
  const failures = outcome.results.flatMap((result) =>
    result.attempts.flatMap((attempt) => (attempt.error === undefined ? [] : [`${result.test.title}: ${attempt.error.message}`])),
  );
  expect(failures, JSON.stringify(outcome.report.run.errors)).toEqual([]);
  expect(outcome.exitCode).toBe(0);
}

/** A step the cache served whole: no model turn, the recorded verdict as its explanation. */
export function expectReplayed(step: StepRecord, actions: number): void {
  expect(step.status).toBe('passed');
  expect(step.cache).toEqual({ mode: 'self-finalized', replayedActions: actions, totalActions: actions });
  expect(step.metrics?.modelCalls).toBe(0);
  expect(step.explanation).toContain('zero-turn');
}

/** A step the executor ran from the top, with the reason the report gives. */
export function expectMissed(step: StepRecord, reason: NonNullable<StepCacheInfo['reason']>, totalActions: number): void {
  expect(step.cache).toEqual({ mode: 'missed', reason, replayedActions: 0, totalActions });
}
