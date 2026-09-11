import { describe, expect, it } from 'vitest';
import { engineRange, playwrightRange } from '../../src/cli/init/engines.ts';

describe('engineRange', () => {
  it('asks for the minor of the engine version the build recorded', () => {
    expect(engineRange('0.7.0')).toBe('^0.7.0');
  });

  it('accepts any 0.x when running from source, where nothing was recorded', () => {
    expect(engineRange(undefined)).toBe('0.x');
  });
});

describe('playwrightRange', () => {
  it('asks for the minor of the Playwright the engine was built against', () => {
    expect(playwrightRange('1.63.0')).toBe('^1.63.0');
  });

  it('accepts any 1.x when running from source, where nothing was recorded', () => {
    expect(playwrightRange(undefined)).toBe('^1');
  });
});
