import { describe, expect, it } from 'vitest';
import { realmSlot } from 'e2e-core/lib/internal/realm-slot';

describe('realmSlot', () => {
  it('shares values across slot instances created with the same key (cross-realm contract)', () => {
    const writer = realmSlot<string>('e2e.test.slot.shared');
    const reader = realmSlot<string>('e2e.test.slot.shared');
    const host = {};
    writer.set(host, 'value');
    expect(reader.get(host)).toBe('value');
    const functionHost = (): void => undefined;
    writer.set(functionHost, 'on-function');
    expect(reader.get(functionHost)).toBe('on-function');
  });

  it('stores the value non-enumerably so it never leaks via iteration or JSON', () => {
    const slot = realmSlot<string>('e2e.test.slot.hidden');
    const host: Record<string, unknown> = { visible: 1 };
    slot.set(host, 'secret');
    expect(Object.keys(host)).toEqual(['visible']);
    expect(JSON.stringify(host)).toBe('{"visible":1}');
  });
});
