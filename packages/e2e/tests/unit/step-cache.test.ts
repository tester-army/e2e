/** StepTraceSession: store resilience, staging anchors, replay postconditions, the write-side decision. */

import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushStagedTraces, type AgentCacheContext, type ClaimedKey } from '../../src/cache/context.ts';
import { instructionDigest, paramsDigest } from '../../src/cache/identity.ts';
import { StoredRecordings } from '../../src/cache/rekeyed.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { buildTraceEntry, type ActionTrace, type DerivedReason, type TraceEntry } from '../../src/cache/trace.ts';
import { failedStepOutcome, recordedVerdictOf, StepTraceSession, type StepCacheHost, type StepCacheOptions } from '../../src/agent/step-cache.ts';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import type { SettleMode } from '../../src/agent/settle-policy.ts';
import type { RedactedNode } from '../../src/agent/observation.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { redacted, redactedNodes } from '../helpers/redacted.ts';
import type { JsonValue } from '../../src/types.ts';
import { SecretLedger } from '../../src/internal/redact.ts';

const savedMarker: SemanticNode = {
  ref: { id: 'm1', revision: 'r1' },
  role: 'status',
  name: 'Marker',
  text: 'saved',
};
const savedAnchor = { role: 'status', name: 'Marker', text: 'saved' };

function nodeMap(list: readonly SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

/** The step every session here runs, as an entry records it. */
const exampleStep = {
  testId: 'tests/example.e2e.ts::step',
  targetId: 'web',
  instructionDigest: instructionDigest('open billing'),
  paramsDigest: paramsDigest(undefined),
  callIndex: 0,
  agent: 'default',
} as const;

/** A claim of `keyHash` for the example step. */
function claimedKey(keyHash: string): ClaimedKey {
  return { keyHash, step: exampleStep };
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
    strict: false,
    claimKey: () => claimedKey('a'.repeat(64)),
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
  const nextScreen = async () => {
    const path = paths.shift();
    return {
      kind: 'semantic' as const,
      nodes: nodeMap((screens.length > 1 ? screens.shift() : screens[0]) ?? []),
      viewport: { width: 1280, height: 720 },
      ...(path === undefined ? {} : { path }),
    };
  };
  return {
    observe: nextScreen,
    actions: { navigate: async () => undefined } as unknown as ExecutorActions,
    signal: new AbortController().signal,
    // Short enough that a missing anchor is not waited for across the backoff.
    remainingMs: () => 50,
    traceEligible: true,
    replaying: () => undefined,
  };
}

function makeSession(cache: AgentCacheContext, host: StepCacheHost, overrides: Partial<StepCacheOptions> = {}): StepTraceSession {
  return new StepTraceSession(host, {
    cache,
    instruction: 'open billing',
    params: undefined,
    templates: [],
    executor: { name: 'test' },
    agent: { name: 'default', context: undefined },
    redact: (text) => text,
    redactCut: (text) => text,
    maxActions: 25,
    stepIndex: 1,
    ...overrides,
  });
}

/** A session whose host's grammar records into it, as the real dispatch's does. */
function recordingSession(
  cache: AgentCacheContext,
  paths: (string | undefined)[],
  screens: (readonly SemanticNode[])[] = [[]],
): StepTraceSession {
  let session: StepTraceSession | undefined;
  const host: StepCacheHost = {
    ...makeHost(paths, screens),
    actions: {
      navigate: async (url: string) => session?.record({ name: 'navigate', url }),
    } as unknown as ExecutorActions,
  };
  session = makeSession(cache, host);
  return session;
}

const noEntry = fakeContext(async () => {
  throw new Error('no entry');
});

/** The recording a staged entry would write; an entry staged to keep fails the test. */
function stagedTrace(context: AgentCacheContext, index = 0): ActionTrace {
  const staged = context.staged[index];
  if (staged?.kind !== 'write') throw new Error(`expected a staged write at ${String(index)}, got ${staged?.kind ?? 'nothing'}`);
  return staged.trace;
}

describe('recordedVerdictOf', () => {
  it('returns a summary the replay did not write as it is', () => {
    expect(recordedVerdictOf('opened the customers page')).toBe('opened the customers page');
    expect(recordedVerdictOf('replayed the flow by hand')).toBe('replayed the flow by hand');
  });

  it('keeps only the recorded verdict of a replay summary, even one that mentions a verdict itself', async () => {
    const context = entryContext({ summary: 'saw "recorded verdict: none" in the log' });
    const session = makeSession(context, makeHost(['/pricing', '/customers#top']));
    const verdict = await session.begin();
    expect(recordedVerdictOf(verdict!.summary!)).toBe('saw "recorded verdict: none" in the log');
  });
});

describe('failedStepOutcome', () => {
  it('reads a cancellation and a model that never answered as no verdict, and every other failure as failed', () => {
    for (const code of ['CANCELLED', 'MODEL_PROVIDER_FAILED', 'MODEL_UNAVAILABLE'] as const) {
      expect(failedStepOutcome(new AgentError(code, 'x'))).toBe('no-verdict');
    }
    for (const code of ['ASSERTION_FAILED', 'STEP_TIMEOUT', 'MODEL_OUTPUT_INVALID', 'CONTEXT_OVERFLOW', 'APP_UNREACHABLE'] as const) {
      expect(failedStepOutcome(new AgentError(code, 'x'))).toBe('failed');
    }
    expect(failedStepOutcome(new Error('MODEL_PROVIDER_FAILED'))).toBe('failed');
  });
});

describe('StepTraceSession', () => {
  it('does not replay or stage after an observation loses semantic evidence', async () => {
    const cache = entryContext({});
    let eligible = true;
    let captures = 0;
    let actions = 0;
    const host = makeHost(['/pricing']);
    const session = makeSession(cache, {
      ...host,
      get traceEligible() { return eligible; },
      observe: async () => { captures += 1; eligible = false; return { kind: 'pixels', path: '/pricing', viewport: { width: 1280, height: 720 } }; },
      actions: { navigate: async () => { actions += 1; } } as unknown as ExecutorActions,
    });
    expect(await session.begin()).toBeUndefined();
    expect(session.cacheInfo?.mode).toBe('missed');
    expect(actions).toBe(0);
    expect(captures).toBe(1);
    session.record({ name: 'navigate', url: '/customers' });
    await session.conclude('passed', 'read screenshot');
    expect(cache.staged).toHaveLength(0);
  });

  it('never stages a passing step after missing semantics, even when the final tree recovers', async () => {
    const cache = fakeContext(async () => ({ status: 'miss' }));
    let eligible = true;
    const session = makeSession(cache, { ...makeHost(['/start', '/end']), get traceEligible() { return eligible; } });
    await session.begin();
    session.record({ name: 'navigate', url: '/end' });
    eligible = false;
    await session.conclude('passed', 'finished from pixels');
    expect(cache.staged).toHaveLength(0);
  });

  it('hands off before another cached action when an action loses semantic evidence', async () => {
    const cache = entryContext({ actions: [
      { name: 'navigate', url: '/first', summary: 'opened first' },
      { name: 'navigate', url: '/second', summary: 'opened second' },
    ] });
    let eligible = true;
    const visited: string[] = [];
    const session = makeSession(cache, {
      ...makeHost(['/start']),
      get traceEligible() { return eligible; },
      actions: { navigate: async (url: string) => { visited.push(url); eligible = false; } } as unknown as ExecutorActions,
    });
    expect(await session.begin()).toBeUndefined();
    expect(visited).toEqual(['/first']);
    expect(session.replayedPrefix?.replayedActions).toEqual(['opened first']);
    await session.conclude('passed', 'finished from pixels');
    expect(cache.staged).toHaveLength(0);
  });
  it('turns a rejecting store read into a miss instead of failing the step', async () => {
    const session = makeSession(
      fakeContext(async () => {
        throw new Error('redis connection refused');
      }),
      makeHost(['/']),
    );
    await expect(session.begin()).resolves.toBeUndefined();
    expect(session.cacheInfo).toEqual({
      mode: 'missed',
      reason: 'invalid-entry',
      replayedActions: 0,
      totalActions: 0,
    });
    expect(session.replayedPrefix).toBeUndefined();
  });

  it('names a retry attempt as the miss reason without reading the store', async () => {
    let reads = 0;
    const session = makeSession(
      {
        ...fakeContext(async () => {
          reads += 1;
          return { status: 'miss' };
        }),
        replayEligible: false,
      },
      makeHost(['/']),
    );
    await expect(session.begin()).resolves.toBeUndefined();
    expect(reads).toBe(0);
    expect(session.cacheInfo).toEqual({ mode: 'missed', reason: 'retry', replayedActions: 0, totalActions: 0 });
    expect(session.replayedPrefix).toBeUndefined();
  });

  it('misses a truncated entry without replaying any of its actions, so the executor runs from the top', async () => {
    const tapUpgrade = { name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } } as const;
    const context = entryContext({
      actions: Array.from({ length: 50 }, () => tapUpgrade),
      startPath: '/pricing',
      truncated: true,
    });
    let taps = 0;
    const session = makeSession(context, {
      ...makeHost(['/pricing']),
      actions: { tap: async () => { taps += 1; } } as unknown as ExecutorActions,
    });
    await expect(session.begin()).resolves.toBeUndefined();
    expect(taps).toBe(0);
    expect(session.replayedPrefix).toBeUndefined();
    expect(session.cacheInfo).toEqual({ mode: 'missed', reason: 'truncated', replayedActions: 0, totalActions: 50 });
  });

  it('degrades a hit that is not a trace-1 entry to a miss, whichever store returned it', async () => {
    const malformed = { schemaVersion: 'trace-1', payload: { actions: 'not a list' } } as unknown as TraceEntry;
    const session = makeSession(
      fakeContext(async () => ({ status: 'hit', entry: malformed, bytes: 1 })),
      makeHost(['/']),
    );
    await expect(session.begin()).resolves.toBeUndefined();
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
    const withheld = makeSession(unanchored, makeHost([]));
    await withheld.begin();
    withheld.record({
      name: 'tap',
      node: redacted({ ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Upgrade' }),
    });
    await withheld.conclude('passed', 'passed');
    expect(unanchored.staged).toHaveLength(0);

    // A navigate-opening trace anchors itself and stages without a path.
    const anchored = fakeContext(noEntry.store.read);
    const staged = makeSession(anchored, makeHost([], [[], [savedMarker]]));
    await staged.begin();
    staged.record({ name: 'navigate', url: '/billing' });
    await staged.conclude('passed', 'passed');
    expect(anchored.staged).toHaveLength(1);
    expect(stagedTrace(anchored).startPath).toBeUndefined();
  });

  it('takes no unchanged node for the delta when a secret registered after the starting screen masks it', async () => {
    const context = fakeContext(noEntry.store.read);
    const ledger = new SecretLedger();
    const status: SemanticNode = { ref: { id: 's', revision: 'r1' }, role: 'status', name: 'Code token-2718-value' };
    const button: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Save marker' };
    const screens = [[status, button], [status, button, savedMarker]];
    const host: StepCacheHost = {
      ...makeHost(['/storage', '/storage']),
      // Each capture is redacted with the ledger as it stood then, as the feed redacts it.
      observe: async () => ({
        kind: 'semantic' as const,
        nodes: redactedNodes((screens.length > 1 ? screens.shift() : screens[0]) ?? [], ledger),
        viewport: { width: 1280, height: 720 },
        path: '/storage',
      }),
    };
    const session = makeSession(context, host, { redact: ledger.redact, redactCut: ledger.redactCut });
    await session.begin();
    // A provider-backed fill resolves the value only now.
    ledger.register('token', 'token-2718-value');
    session.record({ name: 'tap', node: redacted(button, ledger) });
    await session.conclude('passed', 'saved the marker');
    expect(stagedTrace(context).endAnchors).toEqual([savedAnchor]);
  });

  it('stages the delta between the starting and passing screens as end anchors', async () => {
    const context = fakeContext(noEntry.store.read);
    const heading: SemanticNode = { ref: { id: 'h', revision: 'r1' }, role: 'heading', name: 'Storage' };
    const button: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Save marker' };
    // The starting screen is read when the session begins, before any action;
    // the passing screen is read when it stages.
    const session = makeSession(
      context,
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
    await session.begin();
    session.record({ name: 'tap', node: redacted({ ...button, ref: { id: 'b', revision: 'r2' } }) });
    await session.conclude('passed', 'saved the marker');
    expect(stagedTrace(context).endAnchors).toEqual([savedAnchor]);
    expect(stagedTrace(context).endPath).toBe('/storage');
  });

  it('keys on the params with each unique() value as a placeholder, stages the recording with the slot, and fills it from the next call', async () => {
    const keyed: JsonValue[] = [];
    const recording: AgentCacheContext = {
      ...fakeContext(noEntry.store.read),
      claimKey: (_kind, _instruction, params) => {
        keyed.push(params ?? null);
        return claimedKey('a'.repeat(64));
      },
    };
    const first = makeSession(recording, makeHost(['/companies', '/companies/E2E-abc']), {
      params: { name: 'E2E-abc', plan: 'pro' },
      templates: [{ pointer: '/name', value: 'E2E-abc' }],
    });
    await first.begin();
    first.record({ name: 'navigate', url: '/companies/new?name=E2E-abc' });
    await first.conclude('passed', 'created E2E-abc on the pro plan');
    expect(keyed).toEqual([{ name: '{{param:/name}}', plan: 'pro' }]);
    const staged = stagedTrace(recording);
    expect(staged.actions[0]).toMatchObject({ url: '/companies/new?name={{param:/name}}' });
    expect(staged.summary).toBe('created E2E-abc on the pro plan');

    // The next run claims the same key and replays the entry with its own value.
    const replayed: AgentCacheContext = {
      ...entryContext(staged),
      claimKey: (_kind, _instruction, params) => {
        keyed.push(params ?? null);
        return claimedKey('a'.repeat(64));
      },
    };
    const second = makeSession(replayed, makeHost(['/companies', '/companies/E2E-xyz']), {
      params: { name: 'E2E-xyz', plan: 'pro' },
      templates: [{ pointer: '/name', value: 'E2E-xyz' }],
    });
    const verdict = await second.begin();
    expect(verdict?.summary).toContain('recorded verdict: created E2E-abc on the pro plan');
    expect(keyed[1]).toEqual(keyed[0]);

    // A call that did not mark the param cannot fill the slot: a miss, never a literal placeholder on screen.
    const unmarked = makeSession(entryContext(staged), makeHost(['/companies']), { params: { name: 'E2E-xyz', plan: 'pro' } });
    expect(await unmarked.begin()).toBeUndefined();
    expect(unmarked.cacheInfo).toMatchObject({ mode: 'missed' });
  });

  it('records nothing when a unique() value is spelled by another param, and says so in the step detail', async () => {
    const context = fakeContext(noEntry.store.read);
    const session = makeSession(context, makeHost(['/reminders', '/reminders/7']), {
      params: { title: 'Daily', frequency: 'Daily' },
      templates: [{ pointer: '/title', value: 'Daily' }],
    });
    await session.begin();
    session.record({ name: 'navigate', url: '/reminders/new?title=Daily&frequency=Daily' });
    await session.conclude('passed', 'created the Daily reminder');
    expect(context.staged).toEqual([]);
    expect(session.cacheInfo).toMatchObject({ mode: 'missed', notRecorded: 'param-collision' });

    // The same call with a title of its own records, and the detail carries no such note.
    const clean = fakeContext(noEntry.store.read);
    const other = makeSession(clean, makeHost(['/reminders', '/reminders/8']), {
      params: { title: 'Water plants', frequency: 'Daily' },
      templates: [{ pointer: '/title', value: 'Water plants' }],
    });
    await other.begin();
    other.record({ name: 'navigate', url: '/reminders/new?title=Water+plants&frequency=Daily' });
    await other.conclude('passed', 'created the reminder');
    expect(stagedTrace(clean).actions[0]).toMatchObject({ url: '/reminders/new?title={{param:/title|form}}&frequency=Daily' });
    expect(other.cacheInfo).not.toHaveProperty('notRecorded');
  });

  it('records the new screen as anchors for a step that moved to another pathname', async () => {
    const context = fakeContext(noEntry.store.read);
    const session = makeSession(context, makeHost(['/pricing', '/customers?ref=nav'], [[], [savedMarker]]));
    await session.begin();
    session.record({ name: 'navigate', url: '/customers' });
    await session.conclude('passed', 'opened customers');
    expect(stagedTrace(context).endAnchors).toEqual([savedAnchor]);
    expect(stagedTrace(context).endPath).toBe('/customers?ref=nav');
  });

  it("self-finalizes on a created record's page whose minted id differs from the recording", async () => {
    const context = entryContext({ endPath: '/projects/95488a620f65', endAnchors: [savedAnchor] });
    const session = makeSession(context, makeHost(['/pricing', '/projects/0c1d2e3f4a5b'], [[], [savedMarker]]));
    const verdict = await session.begin();
    expect(verdict?.status).toBe('passed');
    expect(session.cacheInfo).toMatchObject({ mode: 'self-finalized' });
  });

  it('still refuses a different page even when the anchors happen to be on it', async () => {
    const context = entryContext({ endPath: '/projects/95488a620f65', endAnchors: [savedAnchor] });
    const session = makeSession(context, makeHost(['/pricing', '/customers'], [[], [savedMarker]]));
    const verdict = await session.begin();
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
  });

  it('refuses to self-finalize when a recorded end anchor is not on screen again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context, makeHost(['/pricing', '/customers']));
    const verdict = await session.begin();
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
    const session = recordingSession(context, ['/pricing', '/customers', '/customers']);
    await session.begin();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The executor looked, agreed the step was done, and recorded nothing more.
    await session.conclude('passed', 'the customers page is open');
    expect(context.staged).toHaveLength(1);
    expect(stagedTrace(context).actions.map((action) => action.name)).toEqual(['navigate']);
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
    const session = recordingSession(context, ['/pricing', '/customers', '/customers']);
    await session.begin();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    // The replayed flow did not produce its effect; the executor acted further.
    session.record({ name: 'tap', node: redacted({ ref: { id: 's', revision: 'r2' }, role: 'button', name: 'Save' }) });
    await session.conclude('passed', 'saved after all');
    expect(context.staged).toHaveLength(0);
    expect(deleted).toEqual(['a'.repeat(64)]);
  });

  it('evicts a consumed entry when the step then fails, and never when nothing judged the app', async () => {
    for (const [outcome, expected] of [
      ['failed', ['a'.repeat(64)]],
      ['no-verdict', []],
    ] as const) {
      const deleted: string[] = [];
      const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
      context.store.delete = async (keyHash) => {
        deleted.push(keyHash);
      };
      const session = makeSession(context, makeHost(['/pricing', '/customers']));
      await session.begin();
      expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
      await session.conclude(outcome, undefined);
      expect(deleted).toEqual(expected);
      expect(context.staged).toHaveLength(0);
    }
  });

  it('evicts nothing on failure when no replay was consumed', async () => {
    const deleted: string[] = [];
    const context = fakeContext(async () => ({ status: 'miss' }));
    context.store.delete = async (keyHash) => {
      deleted.push(keyHash);
    };
    const session = makeSession(context, makeHost(['/']));
    await session.begin();
    await session.conclude('failed', undefined);
    expect(deleted).toEqual([]);
  });

  it('neither stages nor evicts in read-only mode', async () => {
    const deleted: string[] = [];
    const context: AgentCacheContext = {
      ...entryContext({ endPath: '/customers', endAnchors: [savedAnchor] }),
      mode: 'read-only',
    };
    context.store.delete = async (keyHash) => {
      deleted.push(keyHash);
    };
    const session = makeSession(context, makeHost(['/pricing', '/customers']));
    await session.begin();
    await session.conclude('failed', undefined);
    expect(deleted).toEqual([]);
    expect(context.staged).toHaveLength(0);
  });

  it('lets an engine-independent executor run when the baseline cannot be observed, and stages nothing', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    const blindHost: StepCacheHost = {
      ...makeHost(['/', '/billing']),
      observe: async () => {
        throw new Error('no surface to observe');
      },
    };
    const session = makeSession(context, blindHost);
    await expect(session.begin()).resolves.toBeUndefined();
    session.record({ name: 'navigate', url: '/billing' });
    await session.conclude('passed', 'done without looking');
    expect(context.staged).toHaveLength(0);
  });

  it('stages nothing when the passing screen cannot be observed', async () => {
    const context = fakeContext(async () => ({ status: 'miss' }));
    let looks = 0;
    const host: StepCacheHost = {
      ...makeHost(['/', '/billing']),
      observe: async () => {
        looks += 1;
        if (looks > 1) throw new Error('surface went away');
        return { kind: 'semantic', nodes: nodeMap([]), viewport: { width: 1280, height: 720 } };
      },
    };
    const session = makeSession(context, host);
    await session.begin();
    session.record({ name: 'navigate', url: '/billing' });
    await expect(session.conclude('passed', 'done')).resolves.toBeUndefined();
    expect(context.staged).toHaveLength(0);
  });

  it.each(['baseline', 'passing screen'] as const)(
    'propagates a runtime hard stop raised while capturing the %s',
    async (when) => {
      const context = fakeContext(async () => ({ status: 'miss' }));
      let looks = 0;
      const host: StepCacheHost = {
        ...makeHost(['/', '/billing']),
        observe: async () => {
          looks += 1;
          if (when === 'baseline' || looks > 1) throw new AgentError('CANCELLED', 'the attempt was cancelled');
          return { kind: 'semantic', nodes: nodeMap([]), viewport: { width: 1280, height: 720 } };
        },
      };
      const session = makeSession(context, host);
      if (when === 'baseline') {
        await expect(session.begin()).rejects.toMatchObject({ code: 'CANCELLED' });
        return;
      }
      await session.begin();
      session.record({ name: 'navigate', url: '/billing' });
      await expect(session.conclude('passed', 'done')).rejects.toMatchObject({ code: 'CANCELLED' });
    },
  );

  it('self-finalizes when the recorded end anchors are present again', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor] });
    const session = makeSession(context, makeHost(['/pricing', '/customers'], [[savedMarker]]));
    const verdict = await session.begin();
    expect(verdict?.status).toBe('passed');
    expect(session.cacheInfo?.mode).toBe('self-finalized');
  });

  it('refuses to self-finalize when the recorded end path no longer matches', async () => {
    const context = entryContext({ endPath: '/customers' });
    // Start path read, then the post-replay end check landing elsewhere.
    const session = makeSession(context, makeHost(['/pricing', '/moved-away']));
    const verdict = await session.begin();
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
    expect(session.cacheInfo?.mode).toBe('agent-concluded');
  });

  it('hands off on an end route with any literal that differs, the recorded anchors on screen or not', async () => {
    // A slug the runner cannot recognize, or a link that now lands on a lookalike page: another screen either way.
    const slug = makeSession(entryContext({ endPath: '/products/summer-sneaker', endAnchors: [savedAnchor] }), makeHost(['/products', '/products/winter-boot'], [[], [savedMarker]]));
    expect(await slug.begin()).toBeUndefined();
    expect(slug.replayedPrefix?.stopReason).toBe('end-mismatch');

    const lookalike = makeSession(entryContext({ endPath: '/settings-page', endAnchors: [savedAnchor] }), makeHost(['/nav', '/profile'], [[], [savedMarker]]));
    expect(await lookalike.begin()).toBeUndefined();
    expect(lookalike.replayedPrefix?.stopReason).toBe('end-mismatch');

    const query = makeSession(entryContext({ endPath: '/task?mode=safe', endAnchors: [savedAnchor] }), makeHost(['/nav', '/task?mode=unsafe'], [[], [savedMarker]]));
    expect(await query.begin()).toBeUndefined();
    expect(query.replayedPrefix?.stopReason).toBe('end-mismatch');
  });

  it('hands off when the recorded delta did not happen during the replay', async () => {
    const draft: SemanticNode = { ref: { id: 'd', revision: 'r1' }, role: 'status', name: 'Marker', text: 'draft' };
    const draftAnchor = { role: 'status', name: 'Marker', text: 'draft' };
    const tap = [{ name: 'tap' as const, summary: 'tap button "Submit"', target: { role: 'button', name: 'Submit' } }];
    const submit: SemanticNode = { ref: { id: 's', revision: 'r1' }, role: 'button', name: 'Submit' };
    const replay = (trace: Partial<ActionTrace>, screens: (readonly SemanticNode[])[]) => {
      const host = makeHost(['/form', '/form'], screens);
      return makeSession(entryContext({ actions: tap, startPath: '/form', endPath: '/form', ...trace }), {
        ...host,
        actions: { tap: async () => undefined } as unknown as ExecutorActions,
      });
    };
    // The effect happened: the draft gave way to the saved marker.
    const good = replay({ endAnchors: [savedAnchor], goneAnchors: [draftAnchor] }, [[submit, draft], [submit, savedMarker]]);
    expect((await good.begin())?.status).toBe('passed');
    expect(good.cacheInfo?.mode).toBe('self-finalized');

    // The saved marker already showed before the submit, which did nothing: no proof.
    const already = replay({ endAnchors: [savedAnchor], goneAnchors: [draftAnchor] }, [[submit, savedMarker]]);
    expect(await already.begin()).toBeUndefined();
    expect(already.cacheInfo).toMatchObject({ mode: 'agent-concluded', reason: 'end-mismatch' });

    // A removal that did not happen: the vanished node is still there.
    const kept = replay({ goneAnchors: [draftAnchor] }, [[submit, draft]]);
    expect(await kept.begin()).toBeUndefined();
    expect(kept.cacheInfo).toMatchObject({ reason: 'end-mismatch' });

    // A recording with no delta at all and no move proves nothing.
    const blind = replay({}, [[submit]]);
    expect(await blind.begin()).toBeUndefined();
    expect(blind.cacheInfo).toMatchObject({ reason: 'end-mismatch' });
  });

  it('measures the evidence from the page a recorded navigate opened, not from the screen the replay began on', async () => {
    const home: SemanticNode = { ref: { id: 'h', revision: 'r1' }, role: 'heading', name: 'Home' };
    const off: SemanticNode = { ref: { id: 's', revision: 'r1' }, role: 'switch', name: 'Email alerts' };
    const on: SemanticNode = { ...off, states: { checked: true } };
    const trace: Partial<ActionTrace> = {
      actions: [
        { name: 'navigate', summary: 'navigate to "/settings"', url: '/settings' },
        { name: 'tap', summary: 'tap switch "Email alerts"', target: { role: 'switch', name: 'Email alerts' } },
      ],
      endPath: '/settings',
      endAnchors: [{ role: 'switch', name: 'Email alerts', states: ['checked'] }],
      goneAnchors: [{ role: 'heading', name: 'Home' }],
    };
    const replay = (screens: (readonly SemanticNode[])[]) => {
      const host = makeHost(['/home', ...Array.from({ length: 8 }, () => '/settings')], screens);
      return makeSession(entryContext(trace), {
        ...host,
        actions: { navigate: async () => undefined, tap: async () => undefined } as unknown as ExecutorActions,
      });
    };
    // The switch was off on the settings page and on after the tap: the replay turned it on.
    const good = replay([[home], [off], [on]]);
    expect((await good.begin())?.status).toBe('passed');
    // It was already on when the page opened, from an earlier run, and the tap did nothing.
    const already = replay([[home], [on]]);
    expect(await already.begin()).toBeUndefined();
    expect(already.cacheInfo).toMatchObject({ mode: 'agent-concluded', reason: 'end-mismatch' });
  });

  it('looks at the page a navigate opened before free actions on it, so an outcome already there is no proof', async () => {
    const home: SemanticNode = { ref: { id: 'h', revision: 'r1' }, role: 'heading', name: 'Home' };
    const field: SemanticNode = { ref: { id: 'f', revision: 'r1' }, role: 'textbox', name: 'Email' };
    const subscribed: SemanticNode = { ref: { id: 'ok', revision: 'r1' }, role: 'status', text: "You're subscribed" };
    const trace: Partial<ActionTrace> = {
      actions: [
        { name: 'navigate', summary: 'navigate to "/newsletter"', url: '/newsletter' },
        { name: 'typeText', summary: 'type "a@b.c" into the focused field', value: 'a@b.c', replace: false },
        { name: 'pressKey', summary: 'press "Enter" on the focused field', key: 'Enter' },
      ],
      endPath: '/newsletter',
      endAnchors: [{ role: 'status', text: "You're subscribed" }],
      goneAnchors: [{ role: 'heading', name: 'Home' }],
    };
    const replay = (screens: (readonly SemanticNode[])[]) => {
      const host = makeHost(['/home', ...Array.from({ length: 8 }, () => '/newsletter')], screens);
      return makeSession(entryContext(trace), {
        ...host,
        actions: { navigate: async () => undefined, typeText: async () => undefined, pressKey: async () => undefined } as unknown as ExecutorActions,
      });
    };
    expect((await replay([[home], [field], [field, subscribed]]).begin())?.status).toBe('passed');
    const already = replay([[home], [field, subscribed]]);
    expect(await already.begin()).toBeUndefined();
    expect(already.cacheInfo).toMatchObject({ mode: 'agent-concluded', reason: 'end-mismatch' });
  });

  it('takes no look of the end wait as the end state once the screen moved off the recorded route', async () => {
    const context = entryContext({ endPath: '/customers', endAnchors: [savedAnchor], endWaitMs: 2_000 });
    // The route matches first with the effect missing; the anchors then show on another page.
    const host = { ...makeHost(['/pricing', '/customers', ...Array.from({ length: 20 }, () => '/elsewhere')], [[], [], [savedMarker]]), remainingMs: () => 60_000 };
    const session = makeSession(context, host);
    expect(await session.begin()).toBeUndefined();
    expect(session.cacheInfo).toMatchObject({ reason: 'end-mismatch' });
  }, 30_000);

  it('evicts an entry that did not serve a pass with nothing to record in its place', async () => {
    let deleted = 0;
    const base = entryContext({ actions: [{ name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } }], startPath: '/form', endAnchors: [savedAnchor] });
    const context: AgentCacheContext = { ...base, store: { ...base.store, delete: async () => { deleted += 1; } } };
    const save: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Save' };
    // The saved marker already shows, so the replay hands off; the agent finds the step done without changing anything.
    const host = makeHost(['/form', '/form', '/form'], [[save, savedMarker]]);
    const session = makeSession(context, { ...host, actions: { tap: async () => undefined } as unknown as ExecutorActions });
    expect(await session.begin()).toBeUndefined();
    session.record({ name: 'tap', node: redacted(save) });
    await session.conclude('passed', 'already saved');
    expect(context.staged).toHaveLength(0);
    expect(deleted).toBe(1);
  });

  it('never stages a step that changed nothing a replay could check', async () => {
    const context = fakeContext(noEntry.store.read);
    const button: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Copy link' };
    const session = makeSession(context, makeHost(['/share', '/share'], [[button]]));
    await session.begin();
    session.record({ name: 'tap', node: redacted(button) });
    await session.conclude('passed', 'copied');
    expect(context.staged).toHaveLength(0);
  });

  it('stages what a removal-only step made vanish', async () => {
    const context = fakeContext(noEntry.store.read);
    const item: SemanticNode = { ref: { id: 'i', revision: 'r1' }, role: 'listitem', name: 'Item A' };
    const button: SemanticNode = { ref: { id: 'b', revision: 'r1' }, role: 'button', name: 'Delete' };
    const session = makeSession(context, makeHost(['/items', '/items'], [[item, button], [button]]));
    await session.begin();
    session.record({ name: 'tap', node: redacted(button) });
    await session.conclude('passed', 'deleted');
    expect(stagedTrace(context)).toMatchObject({ goneAnchors: [{ role: 'listitem', name: 'Item A' }] });
    expect(stagedTrace(context).endAnchors).toBeUndefined();
  });

  it('stages the entry it replayed whole to keep, never as a recording, and reports the recorded verdict', async () => {
    const context = entryContext({ endPath: '/customers' });
    let captures = 0;
    const host = makeHost(['/pricing', '/customers#top']);
    const counted = { ...host, observe: async (mode: SettleMode) => { captures += 1; return host.observe(mode); } };
    const session = makeSession(context, counted);
    const verdict = await session.begin();
    expect(verdict?.status).toBe('passed');
    expect(verdict?.summary).toContain('recorded verdict: opened the customers page');
    session.record({ name: 'navigate', url: '/customers' });
    await session.conclude('passed', verdict?.summary);
    // A kept entry carries no payload, so the replay's expansion of it can
    // never be written: confirmed, the file stands as it is; unconfirmed, it
    // is evicted. The passing screen is never captured for it.
    expect(context.staged).toEqual([{ kind: 'keep', keyHash: 'a'.repeat(64), stepIndex: 1 }]);
    expect(captures).toBe(2);
  });

  it('reads the start capture for the first relocation instead of capturing the same screen again', async () => {
    const upgrade: SemanticNode = { ref: { id: 'u', revision: 'r1' }, role: 'button', name: 'Upgrade' };
    const context = entryContext({
      actions: [{ name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } }],
      startPath: '/pricing',
      endPath: '/pricing',
      endAnchors: [savedAnchor],
    });
    const log: SettleMode[] = [];
    const host = makeHost(['/pricing', '/pricing'], [[upgrade], [upgrade, savedMarker]]);
    const session = makeSession(context, {
      ...host,
      observe: async (mode) => { log.push(mode); return host.observe(mode); },
      actions: { tap: async () => undefined } as unknown as ExecutorActions,
    });
    const verdict = await session.begin();
    expect(verdict?.status).toBe('passed');
    // One settled start capture serves the relocation; the end state is one raw look.
    expect(log).toEqual(['held-still', 'raw']);
  });

  it('leaves the entry file untouched across replays and rewrites it after a hand-off the executor healed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-step-cache-'));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    const context = (): AgentCacheContext => ({
      mode: 'read-write',
      store,
      replayEligible: true,
      strict: false,
      claimKey: () => claimedKey('a'.repeat(64)),
      staged: [],
    });
    const file = join(directory, `${'a'.repeat(64)}.json`);
    const snapshot = async () => ({ bytes: await readFile(file, 'utf8'), mtimeMs: (await stat(file)).mtimeMs });
    const run = async (paths: string[], screens: (readonly SemanticNode[])[], lastVerifiedStepIndex = 5) => {
      const current = context();
      const session = recordingSession(current, paths, screens);
      const verdict = await session.begin();
      // On a miss the executor performs the flow itself; a replay's own
      // navigate records through the host's grammar, as the real dispatch's does.
      if (session.cacheInfo?.mode === 'missed') session.record({ name: 'navigate', url: '/customers' });
      await session.conclude('passed', verdict?.summary ?? 'opened the customers page');
      await flushStagedTraces(current, { lastVerifiedStepIndex, implicatesUnconfirmed: true });
      return session;
    };

    // The recording run: a miss, then the flow and its effect are written.
    const recorded = await run(['/pricing', '/customers'], [[], [savedMarker]]);
    expect(recorded.cacheInfo?.mode).toBe('missed');
    const written = await snapshot();
    expect(JSON.parse(written.bytes).payload.endAnchors).toEqual([savedAnchor]);

    // Two replays in a row: the file's bytes and mtime never move.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = await run(['/pricing', '/customers'], [[savedMarker]]);
    expect(first.cacheInfo?.mode).toBe('self-finalized');
    expect(await snapshot()).toEqual(written);
    const second = await run(['/pricing', '/customers'], [[savedMarker]]);
    expect(second.cacheInfo?.mode).toBe('self-finalized');
    expect(await snapshot()).toEqual(written);

    // A hand-off the executor settled without acting re-records with the live anchors.
    const renamed: SemanticNode = { ...savedMarker, text: 'stored' };
    const healed = await run(['/pricing', '/customers', '/customers'], [[], [], [renamed]]);
    expect(healed.replayedPrefix?.stopReason).toBe('end-mismatch');
    const rewritten = await snapshot();
    expect(rewritten.bytes).not.toBe(written.bytes);
    expect(JSON.parse(rewritten.bytes).payload.endAnchors).toEqual([{ ...savedAnchor, text: 'stored' }]);

    // A replay nothing verified afterwards is implicated like a recording would be: evicted.
    const unconfirmed = await run(['/pricing', '/customers'], [[], [renamed]], 0);
    expect(unconfirmed.cacheInfo?.mode).toBe('self-finalized');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes the step for the live progress on a hit, before the start-path probe, and hands it over only when the model must finish it', async () => {
    const log: string[] = [];
    const paths: (string | undefined)[] = [];
    const capture: StepCacheHost['observe'] = async () => {
      log.push('capture');
      const path = paths.shift();
      return { kind: 'semantic', nodes: nodeMap([]), viewport: { width: 1280, height: 720 }, ...(path === undefined ? {} : { path }) };
    };
    const host: StepCacheHost = {
      ...makeHost([]),
      observe: capture,
      replaying: (active) => log.push(active ? 'cache' : 'model'),
    };
    const begin = async (context: AgentCacheContext, ...nextPaths: string[]) => {
      log.length = 0;
      paths.push(...nextPaths);
      const session = makeSession(context, host);
      const verdict = await session.begin();
      return { session, verdict };
    };

    // A replay that finishes the step keeps it: the step ends as the cache's.
    const finished = await begin(entryContext({ endPath: '/customers' }), '/pricing', '/customers');
    expect(finished.verdict?.status).toBe('passed');
    expect(log).toEqual(['cache', 'capture', 'capture']);

    // A hit the decision refuses hands over without replaying.
    const refused = await begin(entryContext({ truncated: true }), '/pricing');
    expect(refused.session.cacheInfo).toMatchObject({ mode: 'missed', reason: 'truncated' });
    expect(log).toEqual(['cache', 'capture', 'model']);

    // A replay that diverges hands over after its actions ran.
    const diverged = await begin(entryContext({ endPath: '/customers' }), '/pricing', '/moved-away');
    expect(diverged.session.replayedPrefix?.stopReason).toBe('end-mismatch');
    expect(log).toEqual(['cache', 'capture', 'capture', 'model']);

    // A miss from the store never takes it.
    await begin(noEntry, '/pricing');
    expect(log).toEqual(['capture']);
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
    strict: false,
    claimKey: () => claimedKey('a'.repeat(64)),
    staged: [],
  };
}

describe('destination path settling', () => {
  it('self-finalizes when the recorded destination arrives after the replayed action', async () => {
    const context = entryContext({ endPath: '/customers' });
    // Start on /pricing; the first read after the replay still sees /pricing
    // (the navigation has not committed), the next sees the destination.
    const host = { ...makeHost(['/pricing', '/pricing', '/customers']), remainingMs: () => 60_000 };
    const verdict = await makeSession(context, host).begin();
    expect(verdict?.status).toBe('passed');
    expect(verdict?.summary).toContain('zero-turn');
  });

  it('still hands off when the destination never arrives within the budget', async () => {
    const context = entryContext({ endPath: '/customers' });
    const host = { ...makeHost(['/pricing', '/pricing', '/pricing', '/pricing']), remainingMs: () => 250 };
    const session = makeSession(context, host);
    const verdict = await session.begin();
    expect(verdict).toBeUndefined();
    expect(session.replayedPrefix?.stopReason).toBe('end-mismatch');
  });
});

describe('flushStagedTraces and a re-recorded flow', () => {
  it('leaves an entry the same flow re-recorded untouched, and replaces it when the actions change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-flush-'));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    const context = (): AgentCacheContext => ({
      mode: 'read-write',
      store,
      replayEligible: true,
      strict: false,
      claimKey: () => claimedKey('c'.repeat(64)),
      staged: [],
    });
    const file = join(directory, `${'c'.repeat(64)}.json`);
    const snapshot = async () => ({ bytes: await readFile(file, 'utf8'), mtimeMs: (await stat(file)).mtimeMs });
    const trace = (summary: string, endWaitMs: number, taps: number): ActionTrace => ({
      actions: Array.from({ length: taps }, (_, index) => ({
        name: 'tap' as const,
        summary: `tap ${String(index)}`,
        target: { role: 'button', name: 'Save' },
      })),
      executor: { name: 'scripted' },
      summary,
      endWaitMs,
      startPath: '/records/1',
      endPath: '/records/1',
      endAnchors: [{ role: 'status', name: 'Record state', text: 'saved' }],
    });
    const flush = async (staged: ActionTrace) => {
      const current = context();
      current.staged.push({ kind: 'write', keyHash: 'c'.repeat(64), stepIndex: 0, trace: staged });
      await flushStagedTraces(current, { lastVerifiedStepIndex: 1, implicatesUnconfirmed: true });
    };

    await flush(trace('saved the record', 10_100, 1));
    const written = await snapshot();
    expect(JSON.parse(written.bytes).payload.summary).toBe('saved the record');

    // A live run of the same flow words its summary differently and measures
    // another end wait; the file is what a replay reads, and nothing it reads changed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush(trace('the record reads saved now', 10_137, 1));
    expect(await snapshot()).toEqual(written);

    // One more tap is a different flow, and the entry follows it.
    await flush(trace('saved after a retry', 10_090, 2));
    const replaced = await snapshot();
    expect(replaced.bytes).not.toBe(written.bytes);
    expect(JSON.parse(replaced.bytes).payload.actions).toHaveLength(2);
  });

  it('leaves an entry untouched when only the rule that flagged a typed value differs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-flush-derived-'));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    const file = join(directory, `${'d'.repeat(64)}.json`);
    const trace = (derived?: DerivedReason): ActionTrace => ({
      actions: [
        { name: 'tool', summary: 'tool type (run-time value)', ...(derived === undefined ? {} : { derived }) },
        { name: 'tap', summary: 'tap Apply', target: { role: 'button', name: 'Apply' } },
      ],
      executor: { name: 'scripted' },
      summary: 'applied the coupon',
      startPath: '/e/iframe-form',
      endPath: '/e/iframe-form',
      endAnchors: [{ role: 'status', name: 'Coupon', text: 'applied' }],
    });
    const flush = async (staged: ActionTrace) => {
      const context: AgentCacheContext = {
        mode: 'read-write',
        store,
        replayEligible: true,
        strict: false,
        claimKey: () => claimedKey('d'.repeat(64)),
        staged: [{ kind: 'write', keyHash: 'd'.repeat(64), stepIndex: 0, trace: staged }],
      };
      await flushStagedTraces(context, { lastVerifiedStepIndex: 1, implicatesUnconfirmed: true });
    };

    // An entry recorded before gaps carried their rule, then live runs whose
    // agent read the value off pixels once and off a node the next time: a
    // replay stops at the gap whatever the rule, so none of them is a new flow.
    await flush(trace());
    const written = await readFile(file, 'utf8');
    await flush(trace('pixels'));
    await flush(trace('minted-token'));
    expect(await readFile(file, 'utf8')).toBe(written);
  });
});

describe('cache.strict', () => {
  const strict = (context: AgentCacheContext): AgentCacheContext => ({ ...context, strict: { advice: 're-record it' } });

  it('fails a step whose recording diverged instead of handing it off, and keeps the cache detail', async () => {
    const context = strict(entryContext({ endPath: '/customers', endAnchors: [savedAnchor] }));
    const session = makeSession(context, makeHost(['/pricing', '/customers']));
    await expect(session.begin()).rejects.toMatchObject({ code: 'REPLAY_STALE', category: 'configuration' });
    expect(session.cacheInfo).toMatchObject({ mode: 'agent-concluded', reason: 'end-mismatch' });
  });

  it('fails an entry it cannot read and a recording made on another screen', async () => {
    const malformed = { schemaVersion: 'trace-1', payload: { actions: 'not a list' } } as unknown as TraceEntry;
    const unreadable = makeSession(strict(fakeContext(async () => ({ status: 'hit', entry: malformed, bytes: 1 }))), makeHost(['/']));
    await expect(unreadable.begin()).rejects.toMatchObject({ code: 'REPLAY_STALE' });
    const elsewhere = makeSession(strict(entryContext({ startPath: '/pricing', actions: [{ name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } }] })), makeHost(['/billing']));
    await expect(elsewhere.begin()).rejects.toMatchObject({ code: 'REPLAY_STALE' });
    expect(elsewhere.cacheInfo).toMatchObject({ mode: 'missed', reason: 'wrong-context' });
  });

  it('still runs live a step with no recording, a retry, and a recording too long to replay', async () => {
    await expect(makeSession(strict(fakeContext(async () => ({ status: 'miss' }))), makeHost(['/'])).begin()).resolves.toBeUndefined();
    const retry = makeSession({ ...strict(fakeContext(async () => ({ status: 'miss' }))), replayEligible: false }, makeHost(['/']));
    await expect(retry.begin()).resolves.toBeUndefined();
    const tapUpgrade = { name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } } as const;
    const truncated = makeSession(
      strict(entryContext({ actions: Array.from({ length: 50 }, () => tapUpgrade), startPath: '/pricing', truncated: true })),
      makeHost(['/pricing']),
    );
    await expect(truncated.begin()).resolves.toBeUndefined();
  });

  it('keeps the stale entry it failed on in read-write mode, so the next strict run fails on it too', async () => {
    const deleted: string[] = [];
    const base = strict(entryContext({ endPath: '/customers', endAnchors: [savedAnchor] }));
    const context: AgentCacheContext = { ...base, store: { ...base.store, delete: async (key) => { deleted.push(key); } } };
    const session = makeSession(context, makeHost(['/pricing', '/customers']));
    await expect(session.begin()).rejects.toMatchObject({ code: 'REPLAY_STALE' });
    await session.conclude('failed', undefined);
    expect(deleted).toEqual([]);
  });

  it('runs live when the store read rejects, since nothing says a recording exists', async () => {
    const session = makeSession(strict(fakeContext(async () => { throw new Error('redis is down'); })), makeHost(['/']));
    await expect(session.begin()).resolves.toBeUndefined();
    expect(session.cacheInfo).toMatchObject({ mode: 'missed', reason: 'invalid-entry' });
  });

  it('replays a recording that still holds as it always does', async () => {
    const context = strict(entryContext({ endPath: '/customers', endAnchors: [savedAnchor] }));
    const verdict = await makeSession(context, makeHost(['/pricing', '/customers'], [[savedMarker]])).begin();
    expect(verdict?.status).toBe('passed');
  });
});

describe('cache.strict and a step whose key changed under its recording', () => {
  const OWN_KEY = 'a'.repeat(64);
  const OLD_KEY = 'b'.repeat(64);
  const recordedPayload = (recordedFor: ActionTrace['recordedFor'], overrides: Partial<ActionTrace> = {}): ActionTrace => ({
    actions: [{ name: 'navigate', summary: 'navigate to "/customers"', url: '/customers' }],
    executor: { name: 'recorded-agent' },
    ...(recordedFor === undefined ? {} : { recordedFor }),
    summary: 'opened the customers page',
    ...overrides,
  });

  /** A file store holding one entry under `OLD_KEY`, and a context whose own key finds nothing in it. */
  async function rekeyedContext(payload: ActionTrace, strict = true): Promise<AgentCacheContext> {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-rekeyed-'));
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    await store.write(OLD_KEY, payload);
    return {
      mode: 'read-only',
      store,
      replayEligible: true,
      strict: strict ? { advice: 're-record it', recordings: new StoredRecordings(store) } : false,
      claimKey: () => claimedKey(OWN_KEY),
      staged: [],
    };
  }

  it('fails with REPLAY_STALE naming the old entry instead of running the step live', async () => {
    const session = makeSession(await rekeyedContext(recordedPayload(exampleStep)), makeHost(['/']));
    const failure = session.begin();
    await expect(failure).rejects.toMatchObject({ code: 'REPLAY_STALE', category: 'configuration' });
    await expect(failure).rejects.toThrow(`stored under another cache key (${OLD_KEY}.json)`);
    await expect(failure).rejects.toThrow('re-record it, then delete the old one');
    expect(session.cacheInfo).toMatchObject({ mode: 'missed', reason: 'no-entry' });
  });

  it('finds an entry recorded before the occurrence fields were, by test, target, and instruction', async () => {
    const { testId, targetId, instructionDigest: digest } = exampleStep;
    const session = makeSession(await rekeyedContext(recordedPayload({ testId, targetId, instructionDigest: digest })), makeHost(['/']));
    await expect(session.begin()).rejects.toMatchObject({ code: 'REPLAY_STALE' });
  });

  it('runs the step live without cache.strict', async () => {
    const session = makeSession(await rekeyedContext(recordedPayload(exampleStep), false), makeHost(['/']));
    await expect(session.begin()).resolves.toBeUndefined();
    expect(session.cacheInfo).toMatchObject({ mode: 'missed', reason: 'no-entry' });
  });

  it('runs live a step the store holds no recording of: another instruction, params, occurrence, agent, test, or target', async () => {
    for (const recordedFor of [
      { ...exampleStep, instructionDigest: instructionDigest('open the billing page') },
      { ...exampleStep, paramsDigest: paramsDigest({ plan: 'pro' }) },
      { ...exampleStep, callIndex: 1 },
      { ...exampleStep, agent: 'admin' },
      { ...exampleStep, testId: 'tests/example.e2e.ts::other' },
      { ...exampleStep, targetId: 'web-b' },
    ]) {
      const session = makeSession(await rekeyedContext(recordedPayload(recordedFor)), makeHost(['/']));
      await expect(session.begin(), JSON.stringify(recordedFor)).resolves.toBeUndefined();
    }
  });

  it('runs live when the only recording is truncated or records no step', async () => {
    const tapUpgrade = { name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade' } } as const;
    const truncated = recordedPayload(exampleStep, { actions: Array.from({ length: 50 }, () => tapUpgrade), truncated: true });
    for (const payload of [truncated, recordedPayload(undefined)]) {
      await expect(makeSession(await rekeyedContext(payload), makeHost(['/'])).begin()).resolves.toBeUndefined();
    }
  });

  it('compares the step as the entry stores it, a registered secret in the title masked, and never names the secret', async () => {
    const secrets = new SecretLedger();
    secrets.register('password', 'hunter2');
    const step = { ...exampleStep, testId: 'tests/example.e2e.ts::logs in with hunter2' };
    const context = await rekeyedContext(recordedPayload({ ...step, testId: secrets.redact(step.testId) }));
    const session = makeSession({ ...context, claimKey: () => ({ keyHash: OWN_KEY, step }) }, makeHost(['/']), { redact: secrets.redact });
    const failure = session.begin();
    await expect(failure).rejects.toMatchObject({ code: 'REPLAY_STALE' });
    await expect(failure).rejects.not.toThrow('hunter2');
  });
});
