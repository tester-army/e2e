import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelCall } from '../../src/agent/model/adapter.ts';
import { explorerFile, explorerSource, type ExploreSpec } from '../../src/explore/explorer.ts';
import { chooseFocuses, exploreFocuses, focusContext } from '../../src/explore/focus.ts';
import { applyGroups, MergeCallError, requestGroups, validateGroups, type MergeAnswer } from '../../src/explore/merge.ts';
import { planInstruction } from '../../src/explore/plan.ts';
import { explorerOfFile, type ExploreProgress } from '../../src/explore/progress.ts';
import { ExploreRecord, type RequestGroups } from '../../src/explore/record.ts';
import { ExploreState } from '../../src/explore/state.ts';
import type { ReportExploreFinding } from '../../src/report/build.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { E2EConfig } from '../../src/types.ts';
import { installFakeModel } from '../helpers/fake-model.ts';
import { createScriptedInstance } from '../helpers/scripted-model.ts';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';

const SCHEMA_PATH = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema', 'report-v1.schema.json');

/** Validates one `run.explore` value against its schema definition. */
function assertValidExplore(value: unknown): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { $id: string };
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/explore`);
  if (validate === undefined) throw new Error('explore definition missing from the report schema');
  if (!validate(value)) throw new Error(JSON.stringify(validate.errors, null, 2));
}

const BUDGETS = { maxSteps: 4, timeoutMs: 300_000 };

function spec(count: number): ExploreSpec {
  return {
    goal: 'Explore the tracker',
    budgets: BUDGETS,
    agentName: 'default',
    accounts: [],
    session: undefined,
    openApp: true,
    focuses: count === 1 ? [] : exploreFocuses(count, { platform: 'web', otherAccount: false }),
  };
}

let ids = 0;
function finding(overrides: Partial<ReportExploreFinding> = {}): ReportExploreFinding {
  ids += 1;
  return {
    id: `finding-${String(ids)}`,
    index: 0,
    step: 1,
    kind: 'issue',
    severity: 3,
    title: 'Count stays at 0',
    expected: 'The count reads 1',
    actual: 'The count reads 0',
    reproduction: ['Create an issue'],
    reportedAt: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}

/** An explorer's moments as its state would announce them: started, one step with the given findings, finished. */
function explorerRun(record: ExploreRecord, explorer: number, findings: readonly ReportExploreFinding[], focus?: string): void {
  const relay = (progress: ExploreProgress) => record.relay(`explore/${String(explorer)}`, progress);
  relay({ phase: 'started', goal: 'Explore the tracker', budgets: BUDGETS, ...(focus === undefined ? {} : { focus }) });
  relay({ phase: 'step-started', step: { index: 1, title: 'Issues', instruction: 'Create an issue' } });
  for (const entry of findings) relay({ phase: 'finding', finding: entry });
  relay({ phase: 'step-finished', step: { index: 1, title: 'Issues', instruction: 'Create an issue', status: 'passed', startedAt: '2026-11-04T10:00:00.000Z', durationMs: 1000 } });
  relay({ phase: 'finished', ended: 'finished', summary: `Explorer ${String(explorer)} is done.` });
}

const neverMerge: RequestGroups = () => Promise.reject(new Error('no merge expected'));

/** A merge call's usage, as `requestGroups` reports it. */
const MERGE_USAGE: MergeAnswer['usage'] = {
  provider: 'fake',
  model: 'merge',
  endpoint: 'local',
  adapterVersion: 'test',
  policyVersion: 'explore-merge/1',
  calls: 1,
  tokenAccounting: 'provider',
  peakTokensPerCall: 430,
  inputTokens: 400,
  outputTokens: 30,
  cacheReadTokens: 100,
  estimatedCostUsd: 0.002,
};

/** A merge call that answers `groups`, or waits for `release` first. */
function answering(groups: readonly (readonly number[])[], release?: Promise<void>): RequestGroups {
  return async () => {
    await release;
    return { groups, usage: MERGE_USAGE };
  };
}
const scope = (notices: string[] = [], signal = new AbortController().signal) => ({ signal, notice: (message: string) => void notices.push(message) });

describe('explore focuses', () => {
  it('gives n explorers the first n focuses in order, named by kind of defect', () => {
    expect(exploreFocuses(3, { platform: 'web', otherAccount: false }).map((focus) => focus.label)).toEqual(['wrong results', 'input and validation', 'state and navigation']);
    expect(exploreFocuses(5, { platform: 'web', otherAccount: false }).map((focus) => focus.label)).toEqual([
      'wrong results',
      'input and validation',
      'state and navigation',
      'layout and environment',
      'errors and recovery',
    ]);
    // Worded for any app: no screen kinds a CRUD web app alone has.
    const texts = exploreFocuses(5, { platform: 'web', otherAccount: false }).map((focus) => focus.text).join(' ');
    expect(texts).not.toMatch(/\brecords?\b|toolbar/);
    expect(texts).toContain('empty, loading, and error states');
  });

  it('words the environment focus for the target\'s platform', () => {
    const environment = (platform: string) => exploreFocuses(4, { platform, otherAccount: false })[3]!.text;
    expect(environment('web')).toContain('resize_viewport');
    expect(environment('web')).toContain('tablet and phone widths');
    for (const platform of ['ios', 'android']) {
      expect(environment(platform)).toContain('rotate the device');
      expect(environment(platform)).toContain('background and resume');
      expect(environment(platform)).toContain('keyboard never covers');
      expect(environment(platform)).toContain('permission prompts');
      expect(environment(platform)).toContain('deep');
      expect(environment(platform)).not.toMatch(/resize_viewport|widths/);
    }
    expect(environment('desktop')).not.toMatch(/resize_viewport|rotate/);
    expect(environment('desktop')).toContain('sizes the app supports');
  });

  it('adds another account\'s view to the environment focus only when there is one to sign in with', () => {
    const [, , , roles] = exploreFocuses(4, { platform: 'ios', otherAccount: true });
    expect(roles).toMatchObject({ label: 'layout and roles', text: expect.stringContaining('sign in as another of the configured accounts') });
    expect(exploreFocuses(4, { platform: 'ios', otherAccount: false })[3]!.text).not.toContain('sign in');
  });

  it('runs the user\'s own focuses in place of the built-in ones, one explorer each, labeled by their first clause', () => {
    const base = { platform: 'web', otherAccount: false };
    expect(chooseFocuses({ ...base, focuses: undefined, parallel: undefined })).toEqual([]);
    expect(chooseFocuses({ ...base, focuses: undefined, parallel: 1 })).toEqual([]);
    expect(chooseFocuses({ ...base, focuses: [], parallel: 2 }).map((focus) => focus.label)).toEqual(['wrong results', 'input and validation']);
    const own = chooseFocuses({ ...base, focuses: [' sharing: invite a second person and revoke access ', 'offline use and sync conflicts after reconnecting to the network'], parallel: undefined });
    expect(own).toEqual([
      { label: 'sharing', text: 'sharing: invite a second person and revoke access' },
      { label: 'offline use and sync conflicts after re…', text: 'offline use and sync conflicts after reconnecting to the network' },
    ]);
    expect(chooseFocuses({ ...base, focuses: ['offline use'], parallel: 1 })).toEqual([{ label: 'offline use', text: 'offline use' }]);
  });

  it('rejects a parallel count that does not match the focuses, more than five focuses, and an empty one', () => {
    const base = { platform: 'web', otherAccount: false };
    expect(() => chooseFocuses({ ...base, focuses: ['a', 'b'], parallel: 3 })).toThrow(
      'parallel is 3 but 2 focuses were given: each explorer takes one focus, so pass as many focuses as explorers, or leave parallel out',
    );
    expect(() => chooseFocuses({ ...base, focuses: ['a', 'b'], parallel: 1 })).toThrow('parallel is 1 but 2 focuses were given');
    expect(() => chooseFocuses({ ...base, focuses: ['a', 'b', 'c', 'd', 'e', 'f'], parallel: undefined })).toThrow('at most 5 focuses, one per explorer, got 6');
    expect(() => chooseFocuses({ ...base, focuses: ['a', '  '], parallel: undefined })).toThrow('a focus must not be empty');
  });

  it('keeps a single explorer with a focus of its own a single exploration', () => {
    const single: ExploreSpec = { ...spec(1), focuses: [{ label: 'offline use', text: 'offline use' }] };
    expect(explorerFile(single, 1)).toBe('explore');
  });

  it('puts the focus beside the goal in the planner prompt, and asks every step to serve it', () => {
    const [focus] = exploreFocuses(2, { platform: 'web', otherAccount: false });
    const focused = planInstruction(new ExploreState('Explore the tracker', BUDGETS, Date.now, focus), { mustFinish: false, remainingMs: 300_000, timeoutMs: 60_000 });
    expect(focused).toContain(`Goal: Explore the tracker\n${focusContext(focus!)}`);
    expect(focused).toContain('Plan every step for the focus on the Focus: line');
    const plain = planInstruction(new ExploreState('Explore the tracker', BUDGETS), { mustFinish: false, remainingMs: 300_000, timeoutMs: 60_000 });
    expect(plain).not.toContain('Focus:');
  });

  it('names each parallel explorer its own virtual file, and a single one the plain file', () => {
    expect(explorerFile(spec(1), 1)).toBe('explore');
    expect([1, 2, 3].map((index) => explorerFile(spec(3), index))).toEqual(['explore/1', 'explore/2', 'explore/3']);
    expect(explorerOfFile('explore/2')).toBe(2);
    expect(explorerOfFile('explore')).toBeUndefined();
    expect(explorerOfFile('explore/0')).toBeUndefined();
    expect(explorerOfFile('tests/explore/2')).toBeUndefined();
  });
});

describe('validateGroups and applyGroups', () => {
  it('keeps the most detailed report of each group, graded as its gravest, with the others', () => {
    const terse = finding({ severity: 2, kind: 'warning', actual: '0' });
    const detailed = finding({ severity: 3, actual: 'The count next to Issues reads 0 after creating one', explorer: 2 });
    const other = finding({ title: 'Sort ignores direction' });
    const merged = applyGroups([terse, other, detailed], validateGroups([[2, 0]], 3));
    expect(merged).toEqual([
      { ...detailed, index: 0, kind: 'issue', severity: 3, merged: [{ id: terse.id, title: terse.title, step: 1 }] },
      { ...other, index: 1, kind: 'issue', severity: 3 },
    ]);
  });

  it('turns every index the model left out into a group of its own', () => {
    expect(validateGroups([[2, 0]], 4)).toEqual([[2, 0], [1], [3]]);
    expect(validateGroups([], 2)).toEqual([[0], [1]]);
  });

  it('rejects a repeated, out-of-range, fractional, or empty grouping instead of repairing it', () => {
    expect(() => validateGroups([[0, 1, 1], [2]], 3)).toThrow('the merge listed finding 1 more than once');
    expect(() => validateGroups([[0, 1], [1, 2]], 3)).toThrow('the merge listed finding 1 more than once');
    expect(() => validateGroups([[0, 3]], 3)).toThrow('the merge answered index 3, out of range for 3 findings');
    expect(() => validateGroups([[-1]], 3)).toThrow('out of range');
    expect(() => validateGroups([[0.5]], 3)).toThrow('out of range');
    expect(() => validateGroups([[]], 3)).toThrow('the merge answered an empty group');
  });
});

describe('requestGroups', () => {
  it('asks the model once with every report, its index, path, and actions, and reports the call as a model record', async () => {
    const calls: ModelCall<unknown>[] = [];
    const adapter: ModelAdapter = {
      provenance: { provider: 'fake', model: 'merge', endpoint: 'local', adapterVersion: 'test' },
      async generate<Value>(call: ModelCall<Value>) {
        calls.push(call as ModelCall<unknown>);
        const validation = call.validate({ groups: [[0, 1, 1]] });
        if (!validation.ok) throw new Error(validation.issue);
        return { value: validation.value, usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 50, accounting: 'provider' as const, estimatedCostUsd: 0.001 }, reasoning: undefined };
      },
    };
    const findings = [finding({ path: '/issues' }), finding({ actual: 'The count reads 0 on the second project' }), finding({ title: 'Sort ignores direction' })];
    const answer = await requestGroups(findings, { adapter, maxInputTokens: 100_000, providerOptions: undefined, signal: new AbortController().signal });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.schemaName).toBe('explore-merge');
    expect(calls[0]!.system).toContain('same kind of screen with different data');
    expect(calls[0]!.prompt).toContain('"index":2');
    expect(calls[0]!.prompt).toContain('"path":"/issues"');
    expect(calls[0]!.prompt).toContain('"reproduction":"Create an issue"');
    expect(calls[0]!.validate({ groups: 'all' }).ok).toBe(false);
    // The grouping passes the call unvalidated, so its usage survives an invalid one.
    expect(answer.groups).toEqual([[0, 1, 1]]);
    expect(answer.usage).toMatchObject({ provider: 'fake', model: 'merge', calls: 1, inputTokens: 300, outputTokens: 20, cacheReadTokens: 50, estimatedCostUsd: 0.001 });
  });
});

describe('requestGroups through the model adapter', () => {
  /** A merge request against `model` through the production adapter. */
  const request = (model: ReturnType<typeof installFakeModel>, signal = new AbortController().signal) =>
    requestGroups([finding(), finding({ title: 'B' })], {
      adapter: createModelAdapter({ provider: model.provider, id: model.modelId, model }),
      maxInputTokens: 100_000,
      providerOptions: undefined,
      signal,
    });

  it('keeps the usage of an answer outside the schema on the error it throws', async () => {
    const failure = await request(installFakeModel(() => ({ groups: 'all' }))).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MergeCallError);
    expect((failure as MergeCallError).usage).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
  });

  it('has no usage to keep when the provider honors the abort and rejects', async () => {
    const controller = new AbortController();
    const model = createScriptedInstance('fake', 'aborting', (options: { abortSignal?: AbortSignal }) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        controller.abort();
      }),
    );
    const failure = await request(model as ReturnType<typeof installFakeModel>, controller.signal).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MergeCallError);
    expect((failure as MergeCallError).reason).toMatchObject({ code: 'CANCELLED' });
    expect((failure as MergeCallError).usage).toBeUndefined();
  });
});

describe('explorerSource', () => {
  it('builds each explorer afresh, reports its progress as the unit\'s events, and runs its test as the explorer', () => {
    const model = installFakeModel(() => ({}));
    const raw = { targets: [{ name: 'web', platform: 'web' }], agents: { default: { model } } } as E2EConfig;
    const source = explorerSource(spec(2), { entry: raw.agents!['default'], config: resolveConfig(raw, { projectRoot: '/project', env: {} }) });
    expect(source.files).toEqual(['explore/1', 'explore/2']);
    const events: unknown[] = [];
    const built = source.build('explore/2', (event) => events.push(event));
    expect(built.registration.tests[0]!.options.agentContext).toContain('Focus: input and validation');
    expect(built.attempts.agents?.get('default')?.tools).toHaveProperty('report_finding');
    expect(() => source.build('explore', () => undefined)).toThrow('no explorer');
    expect(events).toEqual([]);
  });
});

describe('ExploreRecord', () => {
  it('records a single explorer exactly as its state does, with no explorer tags and no merge', async () => {
    const record = new ExploreRecord(spec(1), neverMerge);
    const state = new ExploreState('Explore the tracker', BUDGETS);
    state.subscribe((progress) => record.relay('explore', progress));
    const heard: (number | undefined)[] = [];
    record.subscribe((event) => heard.push(event.explorer));
    state.start();
    state.beginStep('Issues', 'Create an issue');
    state.addFinding({ title: 'Count stays at 0', kind: 'issue', severity: 3, expected: 'one', actual: 'zero', reproduction: ['Create an issue'] });
    state.endStep('passed', 'Created');
    state.end('finished', 'Done.');
    await record.settle(scope());
    expect(record.snapshot()).toEqual({ goal: 'Explore the tracker', budgets: BUDGETS, ended: 'finished', summary: 'Done.', steps: state.steps, findings: state.findings });
    expect(heard.every((explorer) => explorer === undefined)).toBe(true);
  });

  it('tags parallel explorers\' steps and findings, lists the explorers, and ends as the least complete of them', () => {
    const record = new ExploreRecord(spec(2), neverMerge);
    const heard: (number | undefined)[] = [];
    record.subscribe((event) => heard.push(event.explorer));
    explorerRun(record, 1, [finding()], 'core flows');
    record.relay('explore/2', { phase: 'started', goal: 'Explore the tracker', budgets: BUDGETS, focus: 'edge-case input' });
    record.relay('explore/2', { phase: 'finished', ended: 'time' });
    record.relay('explore/9', { phase: 'finished', ended: 'stuck' });
    record.relay('tests/login.setup.e2e.ts', { phase: 'finished', ended: 'stuck' });
    const snapshot = record.snapshot();
    expect(snapshot.ended).toBe('time');
    expect(snapshot.summary).toBeUndefined();
    expect(snapshot.steps.map((step) => step.explorer)).toEqual([1]);
    expect(snapshot.findings.map((entry) => [entry.explorer, entry.index])).toEqual([[1, 0]]);
    expect(snapshot.explorers).toEqual([
      { index: 1, focus: 'wrong results', ended: 'finished', summary: 'Explorer 1 is done.' },
      { index: 2, focus: 'input and validation', ended: 'time' },
    ]);
    expect(new Set(heard)).toEqual(new Set([1, 2]));
    assertValidExplore(snapshot);
  });

  it('merges the explorers\' findings once they are over, and announces the merge with its usage', async () => {
    const asked: ReportExploreFinding[][] = [];
    const record = new ExploreRecord(spec(2), async (findings) => {
      asked.push([...findings]);
      return { groups: [[0, 1]], usage: MERGE_USAGE };
    });
    const announced: ExploreProgress[] = [];
    record.subscribe((event) => {
      if (event.explorer === undefined) announced.push(event.progress);
    });
    const first = finding({ actual: 'The count reads 0 after creating an issue in the first project' });
    const second = finding();
    explorerRun(record, 1, [first]);
    explorerRun(record, 2, [second]);
    await record.settle(scope());
    expect(asked[0]!.map((entry) => [entry.id, entry.explorer, entry.index])).toEqual([[first.id, 1, 0], [second.id, 2, 1]]);
    const snapshot = record.snapshot();
    expect(snapshot.findings).toEqual([{ ...first, explorer: 1, index: 0, merged: [{ id: second.id, title: second.title, explorer: 2, step: 1 }] }]);
    expect(snapshot.merge).toEqual({ status: 'merged', reported: 2, model: MERGE_USAGE });
    expect(announced).toEqual([{ phase: 'merge', merge: snapshot.merge, findings: snapshot.findings }]);
    assertValidExplore(snapshot);
  });

  it('keeps every finding, and the usage of a call that answered, when the grouping is invalid or the call fails', async () => {
    const invalid = new ExploreRecord(spec(2), answering([[0, 1, 1]]));
    explorerRun(invalid, 1, [finding()]);
    explorerRun(invalid, 2, [finding()]);
    const notices: string[] = [];
    await invalid.settle(scope(notices));
    expect(invalid.snapshot().findings.map((entry) => entry.merged)).toEqual([undefined, undefined]);
    expect(invalid.snapshot().merge).toEqual({ status: 'failed', reported: 2, model: MERGE_USAGE });
    expect(notices).toEqual(['the findings of 2 explorers could not be merged, so all 2 are kept: the merge listed finding 1 more than once']);

    const failing = new ExploreRecord(spec(2), () => Promise.reject(new Error('provider unavailable')));
    explorerRun(failing, 1, [finding()]);
    explorerRun(failing, 2, [finding()]);
    await failing.settle(scope([]));
    expect(failing.snapshot().findings).toHaveLength(2);
    expect(failing.snapshot().merge).toEqual({ status: 'failed', reported: 2 });
  });

  it('counts the usage a failed call carried, an answer outside the schema, before keeping every finding', async () => {
    const record = new ExploreRecord(spec(2), () => Promise.reject(new MergeCallError(new Error('provider response did not match the closed response grammar'), MERGE_USAGE)));
    explorerRun(record, 1, [finding()]);
    explorerRun(record, 2, [finding()]);
    const notices: string[] = [];
    await record.settle(scope(notices));
    expect(record.snapshot().merge).toEqual({ status: 'failed', reported: 2, model: MERGE_USAGE });
    expect(record.snapshot().findings).toHaveLength(2);
    expect(notices).toEqual(['the findings of 2 explorers could not be merged, so all 2 are kept: provider response did not match the closed response grammar']);
  });

  it('records an interrupted merge with no usage when the cancelled call rejects without an answer', async () => {
    const controller = new AbortController();
    const record = new ExploreRecord(spec(2), () => {
      controller.abort();
      return Promise.reject(new MergeCallError(new Error('model call cancelled'), undefined));
    });
    explorerRun(record, 1, [finding()]);
    explorerRun(record, 2, [finding()]);
    await record.settle(scope([], controller.signal));
    expect(record.snapshot().merge).toEqual({ status: 'interrupted', reported: 2 });
    expect(record.snapshot().findings).toHaveLength(2);
  });

  it('keeps every finding and the usage when the run is interrupted while the call is pending', async () => {
    const controller = new AbortController();
    let release = (): void => undefined;
    const record = new ExploreRecord(spec(2), answering([[0, 1]], new Promise<void>((resolve) => { release = resolve; })));
    explorerRun(record, 1, [finding()]);
    explorerRun(record, 2, [finding()]);
    const settled = record.settle(scope([], controller.signal));
    controller.abort();
    release();
    await settled;
    expect(record.snapshot().findings).toHaveLength(2);
    expect(record.snapshot().merge).toEqual({ status: 'interrupted', reported: 2, model: MERGE_USAGE });
    assertValidExplore(record.snapshot());
  });

  it('does not merge a run interrupted before the merge, or one with fewer than two findings', async () => {
    const interrupted = new ExploreRecord(spec(2), neverMerge);
    explorerRun(interrupted, 1, [finding()]);
    explorerRun(interrupted, 2, [finding()]);
    const controller = new AbortController();
    controller.abort();
    await interrupted.settle(scope([], controller.signal));
    expect(interrupted.snapshot().merge).toBeUndefined();
    expect(interrupted.snapshot().findings).toHaveLength(2);

    const single = new ExploreRecord(spec(2), neverMerge);
    explorerRun(single, 1, [finding()]);
    explorerRun(single, 2, []);
    await single.settle(scope());
    expect(single.snapshot().merge).toBeUndefined();
  });

  it('rejects in the schema a parallel record without explorer identity, an explorer past the count, and a merge with one explorer', () => {
    const record = new ExploreRecord(spec(2), neverMerge);
    explorerRun(record, 1, [finding()], 'core flows');
    explorerRun(record, 2, [finding()], 'edge-case input');
    const valid = record.snapshot();
    assertValidExplore(valid);
    const { explorer: _step, ...untaggedStep } = valid.steps[0]!;
    expect(() => assertValidExplore({ ...valid, steps: [untaggedStep, valid.steps[1]] })).toThrow();
    const { explorer: _finding, ...untaggedFinding } = valid.findings[0]!;
    expect(() => assertValidExplore({ ...valid, findings: [untaggedFinding, valid.findings[1]] })).toThrow();
    expect(() => assertValidExplore({ ...valid, findings: [{ ...valid.findings[0], explorer: 3 }, valid.findings[1]] })).toThrow();
    expect(() => assertValidExplore({ ...valid, steps: [{ ...valid.steps[0], explorer: 999 }, valid.steps[1]] })).toThrow();
    expect(() => assertValidExplore({ ...valid, explorers: [valid.explorers![0], { ...valid.explorers![1], index: 3 }] })).toThrow();
    const { explorers: _explorers, ...single } = valid;
    const singleSteps = single.steps.map((step) => ({ ...step, explorer: undefined }));
    const singleFindings = single.findings.map((entry) => ({ ...entry, explorer: undefined }));
    assertValidExplore({ ...single, steps: singleSteps, findings: singleFindings });
    expect(() => assertValidExplore({ ...single, steps: singleSteps, findings: singleFindings, merge: { status: 'failed', reported: 2 } })).toThrow();
    expect(() => assertValidExplore({ ...single, findings: singleFindings })).toThrow();
    expect(() => assertValidExplore({ ...valid, merge: { status: 'merged', reported: 2 } })).toThrow();
    const absorbed = { id: valid.findings[1]!.id, title: valid.findings[1]!.title, step: 1 };
    expect(() => assertValidExplore({ ...valid, findings: [{ ...valid.findings[0], merged: [absorbed] }] })).toThrow();
    assertValidExplore({ ...valid, findings: [{ ...valid.findings[0], merged: [{ ...absorbed, explorer: 2 }] }] });
    assertValidExplore({ ...valid, merge: { status: 'failed', reported: 2 } });
  });
});
