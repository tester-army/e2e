import { describe, expect, it } from 'vitest';
import { engineRange } from '../../src/cli/init/engines.ts';

describe('engineRange', () => {
  it('asks for the minor of the engine version the build recorded', () => {
    expect(engineRange('0.7.0')).toBe('^0.7.0');
  });

  it('accepts any 0.x when running from source, where nothing was recorded', () => {
    expect(engineRange(undefined)).toBe('0.x');
  });
});
