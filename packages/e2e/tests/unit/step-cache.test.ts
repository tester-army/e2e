/** StepTraceSession resilience: a store outage degrades to a miss (RFC0001 cache-in). */

import { describe, expect, it } from 'vitest';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { StepTraceSession } from '../../src/agent/step-cache.ts';
import type { ReplayHost } from '../../src/agent/replay.ts';

function fakeContext(read: () => Promise<never>): AgentCacheContext {
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

const host: ReplayHost & { currentPath(): Promise<string | undefined> } = {
  observeNodes: async () => new Map(),
  latestShape: () => undefined,
  actions: {} as ReplayHost['actions'],
  signal: new AbortController().signal,
  remainingMs: () => 60_000,
  redact: (text) => text,
  testIdAttribute: 'data-testid',
  currentPath: async () => '/',
};

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
    withheld.stage('passed');
    expect(unanchored.staged).toHaveLength(0);

    // A navigate-opening trace anchors itself and stages without a path.
    const anchored = fakeContext(neverRead);
    const staged = makeSession(anchored);
    staged.record({ name: 'navigate', url: '/billing' });
    staged.stage('passed');
    expect(anchored.staged).toHaveLength(1);
  });
});
