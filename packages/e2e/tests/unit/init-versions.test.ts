import { describe, expect, it } from 'vitest';
import { dependencyRange } from '../../src/cli/init/versions.ts';

describe('dependencyRange', () => {
  it('asks for the minor of the engine version the build recorded', () => {
    expect(dependencyRange('0.7.0')).toBe('^0.7.0');
  });

  it('pins a canary engine to the exact build recorded next to the runner', () => {
    expect(dependencyRange('0.8.0-canary-20260910135247')).toBe('0.8.0-canary-20260910135247');
  });

  it('accepts any 0.x when running from source, where nothing was recorded', () => {
    expect(dependencyRange(undefined)).toBe('0.x');
  });
});
