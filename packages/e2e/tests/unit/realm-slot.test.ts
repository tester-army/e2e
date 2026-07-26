import { describe, expect, it } from 'vitest';
import { realmSlot } from '../../src/internal/realm-slot.ts';

describe('realmSlot', () => {
  it('sets, gets, and deletes a value on a host object', () => {
    const slot = realmSlot<number>('e2e.test.slot.basic');
    const host = {};
    expect(slot.get(host)).toBeUndefined();
    slot.set(host, 42);
    expect(slot.get(host)).toBe(42);
    slot.delete(host);
    expect(slot.get(host)).toBeUndefined();
  });

  it('shares values across slot instances created with the same key (cross-realm contract)', () => {
    const writer = realmSlot<string>('e2e.test.slot.shared');
    const reader = realmSlot<string>('e2e.test.slot.shared');
    const host = {};
    writer.set(host, 'value');
    expect(reader.get(host)).toBe('value');
  });

  it('isolates slots with different keys', () => {
    const a = realmSlot<string>('e2e.test.slot.a');
    const b = realmSlot<string>('e2e.test.slot.b');
    const host = {};
    a.set(host, 'a-value');
    expect(b.get(host)).toBeUndefined();
  });

  it('stores the value non-enumerably so it never leaks via iteration or JSON', () => {
    const slot = realmSlot<string>('e2e.test.slot.hidden');
    const host: Record<string, unknown> = { visible: 1 };
    slot.set(host, 'secret');
    expect(Object.keys(host)).toEqual(['visible']);
    expect(JSON.stringify(host)).toBe('{"visible":1}');
  });

  it('allows overwriting via set because the property stays configurable', () => {
    const slot = realmSlot<number>('e2e.test.slot.overwrite');
    const host = {};
    slot.set(host, 1);
    slot.set(host, 2);
    expect(slot.get(host)).toBe(2);
  });

  it('returns undefined for primitive and nullish hosts instead of throwing', () => {
    const slot = realmSlot<string>('e2e.test.slot.primitives');
    expect(slot.get(null)).toBeUndefined();
    expect(slot.get(undefined)).toBeUndefined();
    expect(slot.get('string')).toBeUndefined();
    expect(slot.get(7)).toBeUndefined();
    expect(slot.get(true)).toBeUndefined();
    expect(slot.get(Symbol('x'))).toBeUndefined();
  });

  it('supports function hosts', () => {
    const slot = realmSlot<string>('e2e.test.slot.function');
    const host = () => undefined;
    slot.set(host, 'on-function');
    expect(slot.get(host)).toBe('on-function');
  });

  it('delete is safe when the slot was never set', () => {
    const slot = realmSlot<string>('e2e.test.slot.delete-empty');
    expect(() => slot.delete({})).not.toThrow();
  });
});
