/** The host event emitter: envelope stamping, quarantine, result flattening. */

import { describe, expect, it } from 'vitest';
import { createRunEventEmitter, toEventResult, type RunEvent } from '../../src/run/events.ts';
import type { ResultRecord } from '../../src/run/records.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';

function fact(total: number): { type: 'plan'; total: number } {
  return { type: 'plan', total };
}

describe('createRunEventEmitter', () => {
  it('is a no-op without sinks', () => {
    const emit = createRunEventEmitter([undefined, undefined]);
    expect(() => emit(fact(1))).not.toThrow();
  });

  it('stamps a monotonic seq starting at 1 and an ISO timestamp', () => {
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([(event) => events.push(event)]);
    emit(fact(1));
    emit(fact(2));
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
  });

  it('quarantines a throwing sink without silencing the healthy one', () => {
    let broken = 0;
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([
      () => {
        broken += 1;
        throw new Error('broken host sink');
      },
      (event) => events.push(event),
    ]);
    expect(() => emit(fact(1))).not.toThrow();
    emit(fact(2));
    emit(fact(3));
    expect(broken).toBe(1);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('quarantines an async sink whose promise rejects, without an unhandled rejection', async () => {
    let calls = 0;
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([
      async () => {
        calls += 1;
        throw new Error('async broken sink');
      },
      (event) => events.push(event),
    ]);
    emit(fact(1));
    // The rejection settles on a later tick; quarantine must land before the
    // next emit that follows it.
    await new Promise((resolve) => setImmediate(resolve));
    emit(fact(2));
    emit(fact(3));
    expect(calls).toBe(1);
    expect(events).toHaveLength(3);
  });

  it('emits JSON-serializable events', () => {
    const events: RunEvent[] = [];
    const emit = createRunEventEmitter([(event) => events.push(event)]);
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
      status: 'passed',
      selected: true,
      attempts: [],
    };
    const event = toEventResult(record);
    expect(event.target).toEqual({ name: 'web', platform: 'web' });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
