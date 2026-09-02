/** StepTraceSession: store resilience, staging anchors, replay postconditions. */

import { describe, expect, it } from 'vitest';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { buildTraceEntry, type ActionTrace, type TraceEntry } from '../../src/cache/trace.ts';
import { StepTraceSession, type StepCacheHost } from '../../src/agent/step-cache.ts';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import type { SemanticNode } from '../../src/backend/surface.ts';

const savedMarker: SemanticNode = {
  ref: { id: 'm1', revision: 'r1' },
  role: 'status',
  name: 'Marker',
  text: 'saved',
};
const savedAnchor = { role: 'status', name: 'Marker', text: 'saved' };

function nodeMap(list: readonly SemanticNode[]): ReadonlyMap<string, SemanticNode> {
  return new Map(list.map((node) => [node.ref.id, node]));
}

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

function makeHost(paths: string[], nodes: readonly SemanticNode[] = []): StepCacheHost {
  return {
    observe: async () => ({ nodes: nodeMap(nodes), shape: 'stable' }),
    actions: { navigate: async () => undefined } as unknown as ExecutorActions,
    signal: new AbortController().signal,
    // Short enough that a missing anchor is not waited for across the backoff.
    remainingMs: () => 50,
    redact: (text) => text,
    testIdAttribute: 'data-testid',
    currentPath: async () => paths.shift() ?? '/',
    observeSettledNodes: async () => nodeMap(nodes),
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

  it('never stages a trace with no start anchor', async () => {
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
    await withheld.stage('passed', undefined, undefined);
    expect(unanchored.staged).toHaveLength(0);

    // A navigate-opening trace anchors itself and stages without a path.
    const anchored = fakeContext(neverRead);
    const staged = makeSession(anchored);
    staged.record({ name: 'navigate', url: '/billing' });
    await staged.stage('passed', undefined, undefined);
    expect(anchored.staged).toHaveLength(1);
  });

  it('stages the delta between the starting and passing screens as end anchors', async () => {
    const context = fakeContext(async () => {
      throw new Error('no entry');
    });
    const session = makeSession(context);
    // The starting screen is read at replay time, before any action.
    await session.tryReplay(
      makeHost(
        ['/storage'],
        [
          { ref: { id: 'h', revision: 'r1' }, role: 'heading', name: 'Storage' },
          { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Save marker' },
        ],
      ),
    );
    session.record({ name: 'tap', node: { ref: { id: 'b', revision: 'r2' }, role: 'button', name: 'Save marker' } });
    await session.stage(
      'saved the marker',
      '/storage',
      nodeMap([
        { ref: { id: 'h2', revision: 'r2' }, role: 'heading', name: 'Storage' },
        { ref: { id: 'b2', revision: 'r2' }, role: 'button', name: 'Save marker' },
        savedMarker,
      ]),
    );
    expect(context.staged[0]?.trace.endAnchors).toEqual([savedAnchor]);
  });

  it('records no anchors for a step that moved to another pathname', async () => {
    const context = fakeContext(async () => {
      throw new Error('no entry');
    });
    const session = makeSession(context);
    await session.tryReplay(makeHost(['/pricing']));
    session.record({ name: 'navigate', url: '/customers' });
    await session.stage('opened customers', '/customers?ref=nav', nodeMap([savedMarker]));
    expect(context.staged[0]?.trace.endAnchors).toBeUndefined();
    expect(context.staged[0]?.trace.endPath).toBe('/customers?ref=nav');
  });

  it('refuses to self-finalize when a recorded end anchor is not on screen again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context);
    const verdict = await session.tryReplay(makeHost(['/pricing', '/customers']));
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix).toMatchObject({
      stopReason: 'end-mismatch',
      replayedActions: ['navigate to "/customers"'],
    });
    expect(session.cacheInfo).toEqual({
      mode: 'agent-concluded',
      reason: 'end-mismatch',
      replayedActions: 1,
      totalActions: 1,
    });
  });

  it('heals stale anchors when the executor settled an end-mismatch without acting', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context);
    await session.tryReplay(recordingHost(session, ['/pricing', '/customers']));
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The executor looked, agreed the step was done, and recorded nothing more.
    await session.stage('the customers page is open', '/customers', nodeMap([savedMarker]));
    expect(context.staged).toHaveLength(1);
    expect(context.staged[0]?.trace.actions.map((action) => action.name)).toEqual(['navigate']);
  });

  it('evicts instead of re-staging when the executor had to repair after an end-mismatch', async () => {
    const deleted: string[] = [];
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    // A slow store: the eviction must be awaited, not fired and forgotten, or
    // a later read could still be served the stale flow.
    context.store.delete = async (keyHash) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      deleted.push(keyHash);
    };
    const session = makeSession(context);
    await session.tryReplay(recordingHost(session, ['/pricing', '/customers']));
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The replayed flow did not produce its effect; the executor acted further.
    session.record({ name: 'tap', node: { ref: { id: 's', revision: 'r2' }, role: 'button', name: 'Save' } });
    await session.stage('saved after all', '/customers', nodeMap([savedMarker]));
    expect(context.staged).toHaveLength(0);
    expect(deleted).toEqual(['a'.repeat(64)]);
  });

  it('lets a backend-independent executor run when the baseline cannot be observed, and stages nothing', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const session = makeSession(context);
    const blindHost: StepCacheHost = {
      ...makeHost(['/']),
      observeSettledNodes: async () => {
        throw new Error('no surface to observe');
      },
    };
    await expect(session.tryReplay(blindHost)).resolves.toBeUndefined();
    session.record({ name: 'navigate', url: '/billing' });
    await session.stage('done without looking', '/billing', nodeMap([savedMarker]));
    expect(context.staged).toHaveLength(0);
  });

  it('propagates a runtime hard stop raised while capturing the baseline', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const session = makeSession(context);
    const cancelledHost: StepCacheHost = {
      ...makeHost(['/']),
      observeSettledNodes: async () => {
        throw new AgentError('CANCELLED', 'the attempt was cancelled');
      },
    };
    await expect(session.tryReplay(cancelledHost)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('self-finalizes when the recorded end anchors are present again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context);
    const verdict = await session.tryReplay(makeHost(['/pricing', '/customers'], [savedMarker]));
    expect(verdict?.status).toBe('passed');
    expect(session.cacheInfo?.mode).toBe('self-finalized');
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

  it('re-stages the original verdict prose, not the replay wrapper', async () => {
    const context = entryContext({ endPath: '/customers' });
    const session = makeSession(context);
    const verdict = await session.tryReplay(makeHost(['/pricing', '/customers?utm=x']));
    expect(verdict?.status).toBe('passed');
    expect(verdict?.summary).toContain('recorded verdict: opened the customers page');
    session.record({ name: 'navigate', url: '/customers' });
    await session.stage(verdict?.summary, '/customers', undefined);
    expect(context.staged[0]?.trace.summary).toBe('opened the customers page');
  });
});

/** A host whose grammar records into the session, as the real dispatch's does. */
function recordingHost(session: StepTraceSession, paths: string[]): StepCacheHost {
  return {
    ...makeHost(paths),
    actions: {
      navigate: async (url: string) => session.record({ name: 'navigate', url }),
    } as unknown as ExecutorActions,
  };
}

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
