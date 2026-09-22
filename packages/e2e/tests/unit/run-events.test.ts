/** The host event emitter: envelope stamping, quarantine, result flattening. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunEventEmitter, toEventResult, type RunEvent } from '../../src/run/events.ts';
import type { ResultRecord } from '../../src/run/records.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';

function fact(total: number): { type: 'plan'; total: number; files: [] } {
  return { type: 'plan', total, files: [] };
}

/** A healthy subscriber that collects what it is handed. */
function collecting(events: RunEvent[]): { name: string; onEvent: (event: RunEvent) => void } {
  return {
    name: 'collecting',
    onEvent: (event) => {
      events.push(event);
    },
  };
}

describe('createRunEventEmitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op without sinks', () => {
    const emit = createRunEventEmitter([undefined, undefined]);
    expect(() => emit(fact(1))).not.toThrow();
  });

  it('stamps a monotonic seq starting at 1 and an ISO timestamp', () => {
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([collecting(events)]);
    emit(fact(1));
    emit(fact(2));
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
  });

  it('quarantines a throwing sink without silencing the healthy one, and says so once on stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let broken = 0;
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([
      {
        name: 'broken',
        onEvent: () => {
          broken += 1;
          throw new Error('broken host sink');
        },
      },
      collecting(events),
    ]);
    expect(() => emit(fact(1))).not.toThrow();
    emit(fact(2));
    emit(fact(3));
    expect(broken).toBe(1);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
      'e2e: reporter "broken" threw on plan: broken host sink; ignoring it for the rest of the run\n',
    ]);
  });

  it('quarantines an async sink whose promise rejects, without an unhandled rejection', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls = 0;
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([
      {
        name: 'async',
        onEvent: async () => {
          calls += 1;
          throw new Error('async broken sink');
        },
      },
      collecting(events),
    ]);
    emit(fact(1));
    // The rejection settles on a later tick; quarantine must land before the
    // next emit that follows it.
    await new Promise((resolve) => setImmediate(resolve));
    emit(fact(2));
    emit(fact(3));
    expect(calls).toBe(1);
    expect(events).toHaveLength(3);
    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
      'e2e: reporter "async" threw on plan: async broken sink; ignoring it for the rest of the run\n',
    ]);
  });

  it('names a sink once when several of its pending promises reject', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([
      {
        name: 'slow',
        onEvent: () => new Promise((_resolve, reject) => setImmediate(() => reject(new Error('late'))))
      },
      collecting(events),
    ]);
    // Both promises are pending when the second event is emitted; both reject on the next tick.
    emit(fact(1));
    emit(fact(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit(fact(3));
    expect(events).toHaveLength(3);
    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
      'e2e: reporter "slow" threw on plan: late; ignoring it for the rest of the run\n',
    ]);
  });

  it('emits JSON-serializable events', () => {
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([collecting(events)]);
    emit(fact(7));
    const roundTripped = JSON.parse(JSON.stringify(events[0]));
    expect(roundTripped).toEqual(events[0]);
  });
});

describe('toEventResult', () => {
  it('replaces the live target with its stable identity', () => {
    const target = {
      name: 'web',
      platform: 'web',
      driver: { launch: () => undefined },
    } as unknown as ResolvedTarget;
    const record: ResultRecord = {
      test: {
        id: 't-1',
        title: 'a test',
        titlePath: ['a test'],
        file: 'tests/a.e2e.ts',
      } as unknown as ResultRecord['test'],
      target,
      agent: 'default',
      repeat: 0,
      status: 'passed',
      selected: true,
      attempts: [],
    };
    const event = toEventResult(record);
    expect(event.target).toEqual({ name: 'web', platform: 'web' });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
