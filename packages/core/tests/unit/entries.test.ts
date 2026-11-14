import { describe, expect, it } from 'vitest';
import * as engine from '../../src/engine/index.ts';

describe('e2e-core entries', () => {
  it('export the engine contract, and nothing of the test runner', () => {
    expect(Object.keys(engine)).toContain('defineEngine');
    expect(Object.keys(engine)).not.toContain('test');
  });
});
