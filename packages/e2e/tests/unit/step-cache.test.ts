/** StepTraceSession resilience: a store outage degrades to a miss (RFC0001 cache-in). */

import { describe, expect, it } from 'vitest';
import type { AgentCacheContext } from '../../src/cache/context.ts';
import { StepTraceSession } from '../../src/agent/step-cache.ts';
import type { ReplayHost } from '../../src/agent/replay.ts';

function rejectingContext(): AgentCacheContext {
  return {
    mode: 'read-write',
    store: {
      writable: true,
      read: async () => {
        throw new Error('redis connection refused');
      },
      write: async () => undefined,
    },
    replayEligible: true,
    keyHashFor: () => 'a'.repeat(64),
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

describe('StepTraceSession', () => {
  it('turns a rejecting store read into a miss instead of failing the step', async () => {
    const session = new StepTraceSession({
      cache: rejectingContext(),
      instruction: 'open billing',
      params: undefined,
      executor: { name: 'test' },
      redact: (text) => text,
      testIdAttribute: 'data-testid',
      maxActions: 25,
      stepIndex: 1,
    });
    await expect(session.tryReplay(host)).resolves.toBeUndefined();
    expect(session.cacheInfo).toEqual({
      mode: 'missed',
      reason: 'invalid-entry',
      replayedActions: 0,
      totalActions: 0,
    });
    expect(session.replayedPrefix).toBeUndefined();
  });
});
