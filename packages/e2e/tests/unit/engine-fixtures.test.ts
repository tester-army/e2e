import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { snapshot } from '../helpers/snapshot.ts';

describe('defineEngine fixtures', () => {
  it('binds fixture factories to the spec like every other member', () => {
    class ClassEngine {
      readonly name = 'classy';
      readonly version = '1.0.0';
      readonly spiVersion = 1 as const;
      readonly greeting = 'hello';
      readonly fixtures = { hello: this.hello };
      async observe() {
        return snapshot([]);
      }
      hello(this: ClassEngine) {
        return this.greeting;
      }
    }
    const handle = defineEngine(new ClassEngine() as never) as unknown as {
      fixtures: Record<string, () => unknown>;
    };
    const factory = handle.fixtures['hello']!;
    expect(factory()).toBe('hello');
    expect(Object.isFrozen(handle.fixtures)).toBe(true);
  });
});
