import { describe, expect, it } from 'vitest';
import * as core from '../../src/core/index.ts';
import * as agent from '../../src/core/agent.ts';

describe('e2e-core entries', () => {
  it('export the launch surface, and nothing of the test runner', () => {
    expect(Object.keys(core).toSorted()).toEqual(['ConfigurationError', 'SessionState', 'isE2EError', 'launch']);
  });

  it('export the agent beside the tools and executor seam it is built from', () => {
    expect(Object.keys(agent)).toContain('createAgent');
    expect(Object.keys(agent)).toContain('defineTool');
    expect(Object.keys(agent)).not.toContain('test');
  });
});
