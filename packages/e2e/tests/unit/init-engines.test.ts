import { describe, expect, it } from 'vitest';
import { agentDeviceRange, engineRange, playwrightRange } from '../../src/cli/init/engines.ts';

describe('engineRange', () => {
  it('asks for the minor of the engine version the build recorded', () => {
    expect(engineRange('0.7.0')).toBe('^0.7.0');
  });

  it('pins a canary engine to the exact build recorded next to the runner', () => {
    expect(engineRange('0.8.0-canary-20260910135247')).toBe('0.8.0-canary-20260910135247');
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

describe('agentDeviceRange', () => {
  it('pins the minor line of the agent-device the engine was built against, since 0.x minors break', () => {
    expect(agentDeviceRange('0.21.1')).toBe('0.21.x');
    expect(agentDeviceRange('0.22.0')).toBe('0.22.x');
  });

  it('accepts any 0.x when running from source, where nothing was recorded', () => {
    expect(agentDeviceRange(undefined)).toBe('0.x');
  });
});
