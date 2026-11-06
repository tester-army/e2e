/** Page function results across the BiDi wire: JSON as is, nodes and windows as references, anything else kept as unreadable. */

import { describe, expect, it } from 'vitest';
import { validateJsonValue } from 'e2e/engine';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { callFunction, ElementRef, UnreadableValue, WindowRef } from '../../src/driver/script.ts';

/** A peer whose page function returns `result`. */
function returning(result: unknown) {
  return new FakeBidi().on('script.callFunction', { result: { type: 'success', realm: 'r', result } });
}

describe('callFunction', () => {
  it('reads nodes and windows as references, and keeps an own __proto__ key', async () => {
    const fake = returning({
      type: 'object',
      value: [
        ['node', { type: 'node', sharedId: 's1' }],
        ['window', { type: 'window', value: { context: 'c1' } }],
        ['__proto__', { type: 'string', value: 'kept' }],
      ],
    });
    const value = (await callFunction(fake.connection, 'tab', '() => 0')) as Record<string, unknown>;
    expect(value['node']).toEqual(new ElementRef('s1'));
    expect(value['window']).toEqual(new WindowRef('c1'));
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
  });

  it('keeps a value with no JSON form as unreadable, which a JSON check refuses', async () => {
    const value = await callFunction(returning({ type: 'date', value: '2026-11-01T00:00:00.000Z' }).connection, 'tab', '() => new Date()');
    expect(value).toEqual(new UnreadableValue('date'));
    expect(() => validateJsonValue(value, 'evaluate result')).toThrow('evaluate result must be JSON-safe');
  });

  it('keeps an object the result holds twice, and a cycle as a cycle a JSON check refuses', async () => {
    const shared = { type: 'object', internalId: 'o1', value: [['n', { type: 'number', value: 1 }]] };
    const aliased = (await callFunction(returning({ type: 'object', value: [['a', shared], ['b', { type: 'object', internalId: 'o1' }]] }).connection, 'tab', '() => 0')) as Record<string, unknown>;
    expect(aliased['b']).toBe(aliased['a']);
    expect(aliased['b']).toEqual({ n: 1 });
    const cyclic = await callFunction(returning({ type: 'object', internalId: 'o2', value: [['self', { type: 'object', internalId: 'o2' }]] }).connection, 'tab', '() => 0');
    expect(() => validateJsonValue(cyclic, 'evaluate result')).toThrow('contains a cycle');
  });
});
