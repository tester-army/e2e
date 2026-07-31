/** `--debug` locate cache table (spec 10-determinism.md). */

import { describe, expect, it } from 'vitest';
import { cacheTable } from '../../src/report/debug-steps.ts';
import {
  CACHE_REPLAY_EVENT,
  type StepCacheInfo,
  type StepModelInfo,
  type StepRecord,
} from '../../src/run/steps.ts';
import type { ResultRecord } from '../../src/run/records.ts';

interface StepSpec {
  readonly api: string;
  readonly cache?: StepCacheInfo;
  readonly cacheMs?: number;
  readonly modelMs?: number;
  readonly modelCalls?: number;
}

function step(index: number, spec: StepSpec): StepRecord {
  const events: StepRecord['events'] = [];
  if (spec.cacheMs !== undefined) {
    events.push({
      kind: 'driver',
      name: CACHE_REPLAY_EVENT,
      startedAt: '2026-07-24T12:00:00.000Z',
      durationMs: spec.cacheMs,
      status: 'passed',
    });
  }
  if (spec.modelMs !== undefined) {
    events.push({
      kind: 'model',
      startedAt: '2026-07-24T12:00:00.000Z',
      durationMs: spec.modelMs,
      status: 'passed',
    });
  }
  return {
    id: `s${String(index)}`,
    index,
    kind: 'agent',
    api: spec.api,
    label: 'the Save button',
    status: 'passed',
    startedAt: '2026-07-24T12:00:00.000Z',
    durationMs: 10,
    events,
    artifacts: [],
    ...(spec.cache === undefined ? {} : { cache: spec.cache }),
    ...(spec.modelCalls === undefined
      ? {}
      : {
          model: {
            provider: 'p',
            model: 'm',
            endpoint: 'https://example.invalid',
            adapterVersion: '1',
            policyVersion: '1',
            calls: spec.modelCalls,
            tokenAccounting: 'provider',
            peakTokensPerCall: 0,
            inputTokens: 0,
            outputTokens: 0,
          } satisfies StepModelInfo,
        }),
  };
}

function results(specs: readonly StepSpec[]): ResultRecord[] {
  return [
    {
      test: { id: 't', file: 'a.e2e.ts', titlePath: ['t'], kind: 'test' },
      target: { name: 'web', platform: 'web' },
      status: 'passed',
      selected: true,
      attempts: [
        {
          id: 'a1',
          index: 0,
          status: 'passed',
          startedAt: '2026-07-24T12:00:00.000Z',
          durationMs: 10,
          artifacts: [],
          secondaryErrors: [],
          cleanup: [],
          steps: specs.map((spec, index) => step(index, spec)),
        },
      ],
    } as unknown as ResultRecord,
  ];
}

describe('cacheTable', () => {
  it('returns nothing when the run performed no agent steps', () => {
    expect(cacheTable([], [])).toBe('');
  });

  it('reports each step’s status, key, and reason', () => {
    const table = cacheTable(
      results([
        {
          api: 'agent.tap',
          cache: { status: 'hit', keyHash: 'a'.repeat(64), bytes: 1422, reason: 'replayed X' },
          cacheMs: 6,
        },
        {
          api: 'agent.hover',
          cache: { status: 'bypassed', reason: 'agent.hover is not a cacheable cache-1 method' },
        },
      ]),
      [],
    );
    expect(table).toContain('agent.tap');
    expect(table).toContain('hit');
    // The key is abbreviated: twelve hex characters identify an entry while
    // staying readable next to the other columns.
    expect(table).toContain('aaaaaaaaaaaa');
    expect(table).not.toContain('a'.repeat(64));
    expect(table).toContain('replayed X');
    expect(table).toContain('agent.hover is not a cacheable cache-1 method');
  });

  it('omits steps that never located anything', () => {
    // A judgment or an extraction has no cache dimension. Listing it as
    // "bypassed" would imply the cache could have helped it, and would make the
    // hit rate look far worse than it is.
    expect(cacheTable(results([{ api: 'agent.waitFor', modelMs: 3_000 }]), [])).toBe('');

    const mixed = cacheTable(
      results([
        { api: 'agent.waitFor', modelMs: 3_000 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 5 },
      ]),
      [],
    );
    expect(mixed).toContain('agent.tap');
    expect(mixed).not.toContain('agent.waitFor');
    expect(mixed).toContain('1 hit of 1 cached call');
  });

  // Only a locate hit skips a model call. Path guidance just puts the recorded
  // route into the prompt and the model still decides, so counting its hits as
  // savings reported time that was never saved.
  // A bypassed planning step used to land in the locate mean carrying up to 25
  // planning rounds, overstating what one locate hit saved by that much.
  it('excludes a bypassed planning step from the locate mean', () => {
    const table = cacheTable(
      results([
        {
          api: 'agent.act',
          cache: { kind: 'path', status: 'bypassed' },
          modelMs: 60_000,
          modelCalls: 20,
        },
        { api: 'agent.tap', cache: { status: 'miss' }, modelMs: 900, modelCalls: 1 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 5 },
      ]),
      [],
    );
    expect(table).toContain('est. 900ms model time avoided');
  });

  it('does not price path guidance as avoided model time', () => {
    const table = cacheTable(
      results([
        {
          api: 'agent.act',
          cache: { kind: 'path', status: 'hit' },
          cacheMs: 5,
          modelMs: 4_800,
          modelCalls: 2,
        },
      ]),
      [],
    );
    expect(table).toContain('1 guided by a recorded path');
    expect(table).not.toContain('model time avoided');
  });

  it('counts the mix against cached calls, not against every agent step', () => {
    const table = cacheTable(
      results([
        { api: 'agent.waitFor', modelMs: 5_000 },
        { api: 'agent.extract', modelMs: 8_000 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 5 },
        { api: 'agent.tap', cache: { status: 'miss' }, modelMs: 900, modelCalls: 1 },
      ]),
      [],
    );
    expect(table).toContain('1 hit, 1 miss of 2 cached calls');
  });

  it('prices a hit off locate model time only', () => {
    // The 8s extraction must not inflate the estimate: a hit avoids a locate,
    // and locates in this run cost 900ms.
    const table = cacheTable(
      results([
        { api: 'agent.extract', modelMs: 8_000, modelCalls: 1 },
        { api: 'agent.tap', cache: { status: 'miss' }, modelMs: 900, modelCalls: 1 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 10 },
      ]),
      [],
    );
    expect(table).toContain('est. 900ms model time avoided');
  });

  it('counts the status mix and the time spent consulting the cache', () => {
    const table = cacheTable(
      results([
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 5 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 7 },
        { api: 'agent.tap', cache: { status: 'miss' }, cacheMs: 3 },
      ]),
      [],
    );
    expect(table).toContain('2 hit');
    expect(table).toContain('1 miss');
    expect(table).toContain('of 3 cached calls');
    expect(table).toContain('cache time 15ms');
  });

  it('prices a hit at the mean model call the same run measured', () => {
    // One 900ms model call over one call, so two hits are worth ~1800ms against
    // 20ms of cache time.
    const table = cacheTable(
      results([
        { api: 'agent.tap', cache: { status: 'miss' }, cacheMs: 0, modelMs: 900, modelCalls: 1 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 10 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 10 },
      ]),
      [],
    );
    expect(table).toContain('est. 1800ms model time avoided');
    expect(table).toContain('net 1780ms faster');
  });

  it('says the cache cost more when it did', () => {
    const table = cacheTable(
      results([
        { api: 'agent.tap', cache: { status: 'miss' }, modelMs: 5, modelCalls: 1 },
        { api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 40 },
      ]),
      [],
    );
    expect(table).toContain('net 35ms slower');
  });

  it('offers no estimate when the run never called a model', () => {
    const table = cacheTable(results([{ api: 'agent.tap', cache: { status: 'hit' }, cacheMs: 4 }]), []);
    expect(table).toContain('cache time 4ms');
    expect(table).not.toContain('est.');
  });
});
