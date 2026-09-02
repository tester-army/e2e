import { describe, expect, it } from 'vitest';
import { defineBackend } from '../../src/backend/index.ts';

describe('defineBackend fixtures', () => {
  it('binds fixture factories to the spec like every other member', () => {
    class ClassBackend {
      readonly name = 'classy';
      readonly version = '1.0.0';
      readonly spiVersion = 1 as const;
      readonly greeting = 'hello';
      readonly fixtures = { hello: this.hello };
      async observe() {
        return { nodes: [] };
      }
      hello(this: ClassBackend) {
        return this.greeting;
      }
    }
    const handle = defineBackend(new ClassBackend() as never) as unknown as {
      fixtures: Record<string, () => unknown>;
    };
    const factory = handle.fixtures['hello']!;
    expect(factory()).toBe('hello');
    expect(Object.isFrozen(handle.fixtures)).toBe(true);
  });
});
