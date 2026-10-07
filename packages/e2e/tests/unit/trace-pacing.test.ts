/** Recorded pacing: an action whose recording saw nothing change replays without waiting out the change timeout. */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { EngineError } from '../../src/engine/contract.ts';
import { TestError } from '../../src/internal/errors.ts';
import { QUIET_CHANGE_WAIT_MS, replayTrace, type ReplayHost } from '../../src/agent/replay.ts';
import { flushStagedTraces, type AgentCacheContext } from '../../src/cache/context.ts';
import { TraceRecorder } from '../../src/cache/recorder.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace, type RecordedAction } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted, redactedNodes } from '../helpers/redacted.ts';

const menu: SemanticNode = { ref: { id: 'm', revision: 'r1' }, role: 'listitem', name: 'report.pdf' };
const rename: SemanticNode = { ref: { id: 'r', revision: 'r1' }, role: 'menuitem', name: 'Rename' };

function recorder(maxActions?: number): TraceRecorder {
  const same = (text: string) => text;
  return new TraceRecorder({ redact: same, redactCut: same, ...(maxActions === undefined ? {} : { maxActions }) });
}

const conclusion = {
  executor: { name: 'scripted' },
  recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
  summary: 'renamed',
  startPath: '/files',
};

describe('TraceRecorder pacing', () => {
  it('marks an action quiet when the look after it saw the screen keep its shape, and only then', () => {
    const recording = recorder();
    recording.record({ name: 'secondaryTap', node: redacted(menu) })?.(false);
    recording.record({ name: 'tap', node: redacted(rename) })?.(true);
    const trace = recording.finalize(conclusion)!;
    expect(trace.actions.map((action) => action.quiet)).toEqual([true, undefined]);
  });

  it('lets a note go stale once another action is recorded before the look, which then answers for both', () => {
    const recording = recorder();
    const note = recording.record({ name: 'secondaryTap', node: redacted(menu) });
    // A secret fill arms no wait of its own, but it lands before the look.
    recording.record({ name: 'typeSecret', node: redacted(rename), secret: 'pin' });
    note?.(false);
    expect(recording.finalize(conclusion)!.actions.map((action) => action.quiet)).toEqual([undefined, undefined]);
  });

  it('gives no note to an action dropped at the cap or folded into the scroll before it', () => {
    const capped = recorder(1);
    capped.record({ name: 'tap', node: redacted(rename) });
    expect(capped.record({ name: 'secondaryTap', node: redacted(menu) })).toBeUndefined();
    const folded = recorder();
    folded.record({ name: 'scroll', direction: 'down' })?.(false);
    expect(folded.record({ name: 'scroll', direction: 'down' })).toBeUndefined();
    // A folded scroll is paced in full, since nothing says which repeat was quiet.
    const [scroll] = folded.finalize(conclusion)!.actions;
    expect(scroll).toMatchObject({ name: 'scroll', times: 2 });
    expect(scroll!.quiet).toBeUndefined();
  });
});

describe('quiet in an entry', () => {
  const trace: ActionTrace = {
    actions: [{ name: 'secondaryTap', summary: 'secondary-tap "report.pdf"', target: { role: 'listitem', name: 'report.pdf' }, quiet: true }],
    executor: { name: 'scripted' },
    summary: 'opened the menu',
    startPath: '/files',
  };

  it('round-trips, and an entry with any other value for it is not one this runner trusts', () => {
    const entry = JSON.parse(JSON.stringify(buildTraceEntry(trace)));
    expect(readTraceEntry(entry)?.payload.actions[0]).toEqual(trace.actions[0]);
    entry.payload.actions[0].quiet = false;
    expect(readTraceEntry(entry)).toBeUndefined();
    entry.payload.actions[0].quiet = 'yes';
    expect(readTraceEntry(entry)).toBeUndefined();
  });
});

describe('replayTrace pacing', () => {
  function host(paced: (number | undefined)[]): ReplayHost & { calls: string[] } {
    const calls: string[] = [];
    let wait: number | undefined;
    const act = (name: string) => async () => {
      calls.push(name);
      paced.push(wait);
    };
    return {
      calls,
      traceEligible: true,
      observe: async () => ({ kind: 'semantic', nodes: redactedNodes([menu, rename]), viewport: { width: 1280, height: 720 } }),
      actions: { secondaryTap: act('secondaryTap'), tap: act('tap'), pressKey: act('pressKey') } as unknown as ExecutorActions,
      withChangeWait: async (ms, call) => {
        wait = ms;
        try {
          return await call();
        } finally {
          wait = undefined;
        }
      },
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
    };
  }

  it('runs an action its recording saw change nothing at the short change wait, and no other', async () => {
    const paced: (number | undefined)[] = [];
    const replay = host(paced);
    const actions: RecordedAction[] = [
      { name: 'secondaryTap', summary: 'open the menu', target: { role: 'listitem', name: 'report.pdf' }, quiet: true },
      { name: 'tap', summary: 'tap Rename', target: { role: 'menuitem', name: 'Rename' } },
      { name: 'pressKey', summary: 'press ArrowLeft', key: 'ArrowLeft', quiet: true },
    ];
    const outcome = await replayTrace(replay, { actions, executor: { name: 'scripted' }, summary: 'renamed' });
    expect(outcome).toMatchObject({ completed: true, executed: 3 });
    expect(replay.calls).toEqual(['secondaryTap', 'tap', 'pressKey']);
    expect(paced).toEqual([QUIET_CHANGE_WAIT_MS, undefined, QUIET_CHANGE_WAIT_MS]);
  });
});

describe('replayTrace on a call that fails', () => {
  function failing(cause: Error): ReplayHost & { calls: number; waits: (number | undefined)[] } {
    const state = { calls: 0, waits: [] as (number | undefined)[] };
    let wait: number | undefined;
    return Object.assign(state, {
      traceEligible: true,
      observe: async () => ({ kind: 'semantic' as const, nodes: redactedNodes([menu]), viewport: { width: 1280, height: 720 } }),
      actions: {
        upload: async () => {
          state.calls += 1;
          state.waits.push(wait);
          throw cause;
        },
      } as unknown as ExecutorActions,
      withChangeWait: async (ms: number, call: () => Promise<unknown>) => {
        wait = ms;
        try {
          return await call();
        } finally {
          wait = undefined;
        }
      },
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
    });
  }
  const upload = (): ActionTrace => ({
    actions: [{ name: 'upload', summary: 'upload', target: { role: 'listitem', name: 'report.pdf' }, paths: ['report.pdf'], quiet: true }],
    executor: { name: 'scripted' },
    summary: 'uploaded',
  });

  it('tries a stale node once more, at the same pace both times', async () => {
    const host = failing(new EngineError('NODE_STALE', 'the list re-rendered', { retryable: true }));
    expect(await replayTrace(host, upload())).toMatchObject({ completed: false, stopReason: 'action-failed' });
    expect(host.calls).toBe(2);
    expect(host.waits).toEqual([QUIET_CHANGE_WAIT_MS, QUIET_CHANGE_WAIT_MS]);
  });

  it('never tries again an engine fault that may have landed, or a refused argument', async () => {
    for (const cause of [
      new EngineError('ENGINE_FAILURE', 'the runner timed out', { retryable: false }),
      new TestError('INVALID_ARGUMENT', 'the path is outside the project'),
    ]) {
      const host = failing(cause);
      expect(await replayTrace(host, upload())).toMatchObject({ completed: false, stopReason: 'action-failed' });
      expect(host.calls).toBe(1);
    }
  });
});

describe('flushStagedTraces and pacing', () => {
  async function fileStore(name: string) {
    const directory = await mkdtemp(join(tmpdir(), `e2e-pacing-${name}-`));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    const keyHash = 'e'.repeat(64);
    const context = (staged: AgentCacheContext['staged'][number]): AgentCacheContext => ({
      mode: 'read-write',
      store,
      replayEligible: true,
      strict: false,
      claimKey: () => ({ keyHash, step: conclusion.recordedFor }),
      staged: [staged],
    });
    return { store, keyHash, file: join(directory, `${keyHash}.json`), context };
  }

  const recorded = (quiet: boolean): ActionTrace => ({
    actions: [
      { name: 'secondaryTap', summary: 'open the menu', target: { role: 'listitem', name: 'report.pdf' }, ...(quiet ? { quiet: true as const } : {}) },
      { name: 'tap', summary: 'tap Rename', target: { role: 'menuitem', name: 'Rename' } },
    ],
    executor: { name: 'scripted' },
    recordedFor: { ...conclusion.recordedFor, callIndex: 0, paramsDigest: 'a'.repeat(64), agent: 'default' },
    summary: 'renamed',
    startPath: '/files',
    endAnchors: [{ role: 'textbox', name: 'File name' }],
  });

  it('gives an entry recorded before pacing the pacing of the first recording that has it, then holds it', async () => {
    const { store, keyHash, file, context } = await fileStore('write');
    const settle = (trace: ActionTrace) => flushStagedTraces(context({ kind: 'write', keyHash, stepIndex: 0, trace }), { lastVerifiedStepIndex: 1, implicatesUnconfirmed: true });
    await store.write(keyHash, recorded(false));
    const unpaced = await readFile(file, 'utf8');
    await settle(recorded(true));
    const paced = await readFile(file, 'utf8');
    expect(paced).not.toBe(unpaced);
    expect(JSON.parse(paced).payload.actions[0].quiet).toBe(true);
    // A later run that happened not to see the menu settle quietly is a timing, not a new flow.
    await settle(recorded(false));
    expect(await readFile(file, 'utf8')).toBe(paced);
  });

  it('replaces an entry that did not serve its step even with the same flow, so a stale quiet mark is dropped', async () => {
    const { store, keyHash, file, context } = await fileStore('replace');
    await store.write(keyHash, recorded(true));
    await flushStagedTraces(context({ kind: 'write', keyHash, stepIndex: 0, trace: recorded(false), replaces: true }), {
      lastVerifiedStepIndex: 1,
      implicatesUnconfirmed: true,
    });
    expect(JSON.parse(await readFile(file, 'utf8')).payload.actions[0].quiet).toBeUndefined();
  });
});
