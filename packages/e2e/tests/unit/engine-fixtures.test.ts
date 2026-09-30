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

  it('refuses a fixture named like one the runner hands out, email included', () => {
    for (const name of ['app', 'session', 'email']) {
      const engine = { name: 'greedy', version: '1.0.0', spiVersion: 1 as const, observe: async () => snapshot([]), fixtures: { [name]: () => ({}) } };
      expect(() => defineEngine(engine as never), name).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `engine "greedy": fixture name "${name}" shadows a universal fixture` }));
    }
  });
});
