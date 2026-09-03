/** StepTraceSession: store resilience, staging anchors, replay postconditions. */

import { describe, expect, it } from 'vitest';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { buildTraceEntry, type ActionTrace, type TraceEntry } from '../../src/cache/trace.ts';
import { StepTraceSession, type StepCacheHost } from '../../src/agent/step-cache.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';

function fakeContext(read: AgentCacheContext['store']['read']): AgentCacheContext {
  return {
    mode: 'read-write',
    store: {
      writable: true,
      read,
      write: async () => undefined,
    },
    replayEligible: true,
    claimKeyHash: () => 'a'.repeat(64),
    staged: [],
  };
}

function makeHost(paths: string[]): StepCacheHost {
  return {
    observe: async () => ({ nodes: new Map(), parents: new Map(), shape: 'stable' }),
    actions: { navigate: async () => undefined } as unknown as ExecutorActions,
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    redact: (text) => text,
    testIdAttribute: 'data-testid',
    currentPath: async () => paths.shift() ?? '/',
  };
}

const host = makeHost(['/']);

function makeSession(cache: AgentCacheContext): StepTraceSession {
  return new StepTraceSession({
    cache,
    instruction: 'open billing',
    params: undefined,
    executor: { name: 'test' },
    redact: (text) => text,
    testIdAttribute: 'data-testid',
    maxActions: 25,
    stepIndex: 1,
  });
}

describe('StepTraceSession', () => {
  it('turns a rejecting store read into a miss instead of failing the step', async () => {
    const session = makeSession(
      fakeContext(async () => {
        throw new Error('redis connection refused');
      }),
    );
    await expect(session.tryReplay(host)).resolves.toBeUndefined();
    expect(session.cacheInfo).toEqual({
      mode: 'missed',
      reason: 'invalid-entry',
      replayedActions: 0,
      totalActions: 0,
    });
    expect(session.replayedPrefix).toBeUndefined();
  });

  it('degrades a hit that is not a trace-1 entry to a miss, whichever store returned it', async () => {
    const malformed = { schemaVersion: 'trace-1', payload: { actions: 'not a list' } } as unknown as TraceEntry;
    const session = makeSession(fakeContext(async () => ({ status: 'hit', entry: malformed, bytes: 1 })));
    await expect(session.tryReplay(host)).resolves.toBeUndefined();
    expect(session.cacheInfo).toEqual({
      mode: 'missed',
      reason: 'invalid-entry',
      replayedActions: 0,
      totalActions: 0,
    });
  });

  it('never stages a trace with no start anchor', () => {
    const neverRead = async (): Promise<never> => {
      throw new Error('unused');
    };
    // No tryReplay ran, so no start path was captured — the shape a non-web
    // session produces. A targeted-only trace cannot replay and is withheld.
    const unanchored = fakeContext(neverRead);
    const withheld = makeSession(unanchored);
    withheld.record({
      name: 'tap',
      node: { ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Upgrade' },
    });
    withheld.stage('passed', undefined);
    expect(unanchored.staged).toHaveLength(0);

    // A navigate-opening trace anchors itself and stages without a path.
    const anchored = fakeContext(neverRead);
    const staged = makeSession(anchored);
    staged.record({ name: 'navigate', url: '/billing' });
    staged.stage('passed', undefined);
    expect(anchored.staged).toHaveLength(1);
  });

  it('refuses to self-finalize when the recorded end path no longer matches', async () => {
    const context = entryContext({ endPath: '/customers' });
    const session = makeSession(context);
    // Start path read, then the post-replay end check landing elsewhere.
    const verdict = await session.tryReplay(makeHost(['/pricing', '/moved-away']));
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    expect(session.cacheInfo?.mode).toBe('agent-concluded');
  });

  it('waits for the recorded end text to appear before self-finalizing', async () => {
    const context = entryContext({ endPath: '/customers', endTexts: ['Report ready: 12 rows'], endWaitMs: 5_000 });
    const session = makeSession(context);
    const shapes = ['loading…', 'loading…', 'Report ready: 12 rows exported'];
    const observed: string[] = [];
    const slowHost: StepCacheHost = {
      ...makeHost(['/pricing', '/customers']),
      observe: async () => {
        const shape = shapes.length > 1 ? (shapes.shift() as string) : (shapes[0] as string);
        observed.push(shape);
        return { nodes: new Map(), parents: new Map(), shape };
      },
    };
    const verdict = await session.tryReplay(slowHost);
    expect(verdict?.status).toBe('passed');
    expect(observed.at(-1)).toContain('Report ready');
    expect(session.cacheInfo?.mode).toBe('self-finalized');
  });

  it('hands off when the recorded end text never returns within the recorded wait', async () => {
    const context = entryContext({ endPath: '/customers', endTexts: ['Report ready: 12 rows'], endWaitMs: 300 });
    const session = makeSession(context);
    const stuckHost: StepCacheHost = {
      ...makeHost(['/pricing', '/customers']),
      observe: async () => ({ nodes: new Map(), parents: new Map(), shape: 'Generating report…' }),
    };
    const verdict = await session.tryReplay(stuckHost);
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
  });

  it('stages the end state the step reached, bounded, for the next replay to wait for', () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const session = makeSession(context);
    session.record({ name: 'navigate', url: '/customers' });
    session.stage('done', '/customers', { texts: ['Report ready: 12 rows', 'x'.repeat(400)], waitMs: 33_400.6 });
    const trace = context.staged[0]?.trace;
    expect(trace?.endTexts?.[0]).toBe('Report ready: 12 rows');
    expect(trace?.endTexts?.[1]?.length).toBeLessThanOrEqual(160);
    expect(trace?.endWaitMs).toBe(33_401);
    // Round trip through the stored shape keeps it.
    const entry = buildTraceEntry(trace!);
    expect(entry.payload.endTexts).toEqual(trace?.endTexts);
  });

  it('re-stages the original verdict prose, not the replay wrapper', async () => {
    const context = entryContext({ endPath: '/customers' });
    const session = makeSession(context);
    const verdict = await session.tryReplay(makeHost(['/pricing', '/customers?utm=x']));
    expect(verdict?.status).toBe('passed');
    expect(verdict?.summary).toContain('recorded verdict: opened the customers page');
    session.record({ name: 'navigate', url: '/customers' });
    session.stage(verdict?.summary, '/customers');
    expect(context.staged[0]?.trace.summary).toBe('opened the customers page');
  });
});

/** A context whose store always hits with one navigate-opening trace. */
function entryContext(overrides: Partial<ActionTrace>): AgentCacheContext {
  const payload: ActionTrace = {
    actions: [{ name: 'navigate', summary: 'navigate to "/customers"', url: '/customers' }],
    executor: { name: 'recorded-agent' },
    summary: 'opened the customers page',
    ...overrides,
  };
  return {
    mode: 'read-write',
    store: {
      writable: true,
      read: async () => ({ status: 'hit', entry: buildTraceEntry(payload), bytes: 1 }),
      write: async () => undefined,
    },
    replayEligible: true,
    claimKeyHash: () => 'a'.repeat(64),
    staged: [],
  };
}
