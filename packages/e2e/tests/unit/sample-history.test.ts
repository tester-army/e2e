/**
 * An assertion poll's readings as one event: how many rounds it read, and,
 * when the reading changed or the poll gave up, the readings in order, so a
 * wrong expectation reads differently from a race.
 */

import { describe, expect, it } from 'vitest';
import { SampleHistory } from '../../src/expect/samples.ts';

describe('SampleHistory', () => {
  it('counts the reads of a poll that passed at once and tells no readings', () => {
    const history = new SampleHistory('expect', (text) => text);
    history.add('text "Saved"');
    expect(history.event('passed')).toMatchObject({ kind: 'poll', name: 'expect', status: 'passed', count: 1 });
    expect(history.event('passed').detail).toBeUndefined();
  });

  it('folds repeated readings and says when each new one first showed', () => {
    const history = new SampleHistory('expect', (text) => text);
    for (const value of ['text "Saving"', 'text "Saving"', 'text "Saved"']) history.add(value);
    const event = history.event('passed');
    expect(event.count).toBe(3);
    expect(event.detail).toMatch(/^text "Saving" x2 -> at \d+ms text "Saved"$/);
  });

  it('tells the one reading of a poll that gave up', () => {
    const history = new SampleHistory('waitFor', (text) => text);
    for (let index = 0; index < 4; index += 1) history.add('absent');
    expect(history.event('failed')).toMatchObject({ name: 'waitFor', status: 'failed', count: 4, detail: 'absent x4' });
  });

  it('keeps the first reading and the latest ones when the value kept changing', () => {
    const history = new SampleHistory('expect', (text) => text);
    for (let index = 0; index < 8; index += 1) history.add(`count ${index}`);
    const detail = history.event('failed').detail!;
    expect(detail.startsWith('count 0 -> … -> ')).toBe(true);
    expect(detail).toContain('count 7');
    expect(detail).not.toContain('count 3');
  });

  it('redacts a reading before it is clipped, so no cut leaves the head of a secret', () => {
    const history = new SampleHistory('expect', (text) => text.replaceAll('eyJsecret-token-value', '[secret]'));
    history.add(`value "${'x'.repeat(70)}eyJsecret-token-value"`);
    expect(history.event('failed').detail).not.toContain('eyJ');
  });
});
