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

/**
 * A host whose location reads come from `paths` in order (undefined once
 * exhausted — a surface without a URL) and whose screens come from `screens`
 * in order, the last one repeating. The session reads the location at the
 * start of the step, after a completed replay, and when staging.
 */
function makeHost(
  paths: (string | undefined)[],
  screens: (readonly SemanticNode[])[] = [[]],
): StepCacheHost {
  const nextScreen = async () => nodeMap((screens.length > 1 ? screens.shift() : screens[0]) ?? []);
  return {
    observe: nextScreen,
    observeSettled: nextScreen,
    actions: { navigate: async () => undefined } as unknown as ExecutorActions,
    signal: new AbortController().signal,
    // Short enough that a missing anchor is not waited for across the backoff.
    remainingMs: () => 50,
    redact: (text) => text,
    testIdAttribute: 'data-testid',
    currentPath: async () => paths.shift(),
  };
}

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

const noEntry = fakeContext(async () => {
  throw new Error('no entry');
});

describe('StepTraceSession', () => {
  it('turns a rejecting store read into a miss instead of failing the step', async () => {
    const session = makeSession(
      fakeContext(async () => {
        throw new Error('redis connection refused');
      }),
    );
    await expect(session.begin(makeHost(['/']))).resolves.toBeUndefined();
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
    await expect(session.begin(makeHost(['/']))).resolves.toBeUndefined();
    expect(session.cacheInfo).toEqual({
      mode: 'missed',
      reason: 'invalid-entry',
      replayedActions: 0,
      totalActions: 0,
    });
  });

  it('never stages a trace with no start anchor', async () => {
    // A surface without a location — the shape a non-web session produces. A
    // targeted-only trace could never replay there and is withheld.
    const unanchored = fakeContext(noEntry.store.read);
    const withheld = makeSession(unanchored);
    await withheld.begin(makeHost([]));
    withheld.record({
      name: 'tap',
      node: { ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Upgrade' },
    });
    await withheld.stage('passed');
    expect(unanchored.staged).toHaveLength(0);

    // A navigate-opening trace anchors itself and stages without a path.
    const anchored = fakeContext(noEntry.store.read);
    const staged = makeSession(anchored);
    await staged.begin(makeHost([]));
    staged.record({ name: 'navigate', url: '/billing' });
    await staged.stage('passed');
    expect(anchored.staged).toHaveLength(1);
    expect(anchored.staged[0]?.trace.startPath).toBeUndefined();
  });

  it('stages the delta between the starting and passing screens as end anchors', async () => {
    const context = fakeContext(noEntry.store.read);
    const session = makeSession(context);
    const heading: SemanticNode = { ref: { id: 'h', revision: 'r1' }, role: 'heading', name: 'Storage' };
    const button: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Save marker' };
    // The starting screen is read when the session begins, before any action;
    // the passing screen is read when it stages.
    await session.begin(
      makeHost(
        ['/storage', '/storage'],
        [
          [heading, button],
          [
            { ...heading, ref: { id: 'h2', revision: 'r2' } },
            { ...button, ref: { id: 'b2', revision: 'r2' } },
            savedMarker,
          ],
        ],
      ),
    );
    session.record({ name: 'tap', node: { ...button, ref: { id: 'b', revision: 'r2' } } });
    await session.stage('saved the marker');
    expect(context.staged[0]?.trace.endAnchors).toEqual([savedAnchor]);
    expect(context.staged[0]?.trace.endPath).toBe('/storage');
  });

  it('records no anchors for a step that moved to another pathname', async () => {
    const context = fakeContext(noEntry.store.read);
    const session = makeSession(context);
    await session.begin(makeHost(['/pricing', '/customers?ref=nav'], [[], [savedMarker]]));
    session.record({ name: 'navigate', url: '/customers' });
    await session.stage('opened customers');
    expect(context.staged[0]?.trace.endAnchors).toBeUndefined();
    expect(context.staged[0]?.trace.endPath).toBe('/customers?ref=nav');
  });

  it('refuses to self-finalize when a recorded end anchor is not on screen again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context);
    const verdict = await session.begin(makeHost(['/pricing', '/customers']));
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
    await session.begin(recordingHost(session, ['/pricing', '/customers', '/customers']));
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The executor looked, agreed the step was done, and recorded nothing more.
    await session.stage('the customers page is open');
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
    await session.begin(recordingHost(session, ['/pricing', '/customers', '/customers']));
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The replayed flow did not produce its effect; the executor acted further.
    session.record({ name: 'tap', node: { ref: { id: 's', revision: 'r2' }, role: 'button', name: 'Save' } });
    await session.stage('saved after all');
    expect(context.staged).toHaveLength(0);
    expect(deleted).toEqual(['a'.repeat(64)]);
  });

  it('lets a backend-independent executor run when the baseline cannot be observed, and stages nothing', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const session = makeSession(context);
    const blindHost: StepCacheHost = {
      ...makeHost(['/', '/billing']),
      observeSettled: async () => {
        throw new Error('no surface to observe');
      },
    };
    await expect(session.begin(blindHost)).resolves.toBeUndefined();
    session.record({ name: 'navigate', url: '/billing' });
    await session.stage('done without looking');
    expect(context.staged).toHaveLength(0);
  });

  it('stages nothing when the passing screen cannot be observed', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const session = makeSession(context);
    let looks = 0;
    const host: StepCacheHost = {
      ...makeHost(['/', '/billing']),
      observeSettled: async () => {
        looks += 1;
        if (looks > 1) throw new Error('surface went away');
        return nodeMap([]);
      },
    };
    await session.begin(host);
    session.record({ name: 'navigate', url: '/billing' });
    await expect(session.stage('done')).resolves.toBeUndefined();
    expect(context.staged).toHaveLength(0);
  });

  it.each(['baseline', 'passing screen'] as const)(
    'propagates a runtime hard stop raised while capturing the %s',
    async (when) => {
      const context = fakeContext(async () => ({ status: 'miss' }));
      const session = makeSession(context);
      let looks = 0;
      const host: StepCacheHost = {
        ...makeHost(['/', '/billing']),
        observeSettled: async () => {
          looks += 1;
          if (when === 'baseline' || looks > 1) throw new AgentError('CANCELLED', 'the attempt was cancelled');
          return nodeMap([]);
        },
      };
      if (when === 'baseline') {
        await expect(session.begin(host)).rejects.toMatchObject({ code: 'CANCELLED' });
        return;
      }
      await session.begin(host);
      session.record({ name: 'navigate', url: '/billing' });
      await expect(session.stage('done')).rejects.toMatchObject({ code: 'CANCELLED' });
    },
  );

  it('self-finalizes when the recorded end anchors are present again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context);
    const verdict = await session.begin(makeHost(['/pricing', '/customers'], [[savedMarker]]));
    expect(verdict?.status).toBe('passed');
    expect(session.cacheInfo?.mode).toBe('self-finalized');
  });

  it('refuses to self-finalize when the recorded end path no longer matches', async () => {
    const context = entryContext({ endPath: '/customers' });
    const session = makeSession(context);
    // Start path read, then the post-replay end check landing elsewhere.
    const verdict = await session.begin(makeHost(['/pricing', '/moved-away']));
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    expect(session.cacheInfo?.mode).toBe('agent-concluded');
  });

  it('re-stages the original verdict prose, not the replay wrapper', async () => {
    const context = entryContext({ endPath: '/customers' });
    const session = makeSession(context);
    const verdict = await session.begin(makeHost(['/pricing', '/customers?utm=x', '/customers']));
    expect(verdict?.status).toBe('passed');
    expect(verdict?.summary).toContain('recorded verdict: opened the customers page');
    session.record({ name: 'navigate', url: '/customers' });
    await session.stage(verdict?.summary);
    expect(context.staged[0]?.trace.summary).toBe('opened the customers page');
  });
});

/** A host whose grammar records into the session, as the real dispatch's does. */
function recordingHost(session: StepTraceSession, paths: (string | undefined)[]): StepCacheHost {
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
