import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src/agent/default-agent.ts';
import { isStepExecutor } from '../../src/agent/executor.ts';
import { DEFAULT_EXPERIMENT } from '../../src/explore/experiment.ts';
import { exploreAgents } from '../../src/explore/index.ts';
import { ExploreState } from '../../src/explore/state.ts';
import type { AgentConfig } from '../../src/types.ts';

const options = () => ({
  state: new ExploreState('goal', { maxSteps: 2, timeoutMs: 180_000 }),
  evidence: async () => undefined,
  notices: [] as string[],
  experiment: DEFAULT_EXPERIMENT,
});
const explorerOf = (agents: ReturnType<typeof exploreAgents>): AgentConfig => agents!['default'] as AgentConfig;

describe('exploreAgents', () => {
  it('replaces default with the explorer and keeps the other agents', () => {
    const o = options();
    const agents = exploreAgents({ default: { model: 'openai/gpt-5.6-luna-fast', context: 'shop' }, ux: { context: 'ux' } }, undefined, { ...o, notice: (m) => o.notices.push(m) });
    expect(Object.keys(agents!)).toEqual(['default', 'ux']);
    expect(explorerOf(agents)).toMatchObject({ model: 'openai/gpt-5.6-luna-fast', context: 'shop', maxSteps: 40, maxModelCalls: 40 });
    expect(isStepExecutor(explorerOf(agents).executor)).toBe(true);
    expect(o.notices).toEqual([]);
  });

  it('accepts --agent default on a config that names no default, and builds from the built-in agent', () => {
    const o = options();
    for (const agents of [undefined, { ux: { context: 'ux' } }]) {
      const built = exploreAgents(agents, 'default', { ...o, notice: (m) => o.notices.push(m) });
      expect(isStepExecutor(explorerOf(built).executor)).toBe(true);
      expect(explorerOf(built).model).toBeUndefined();
    }
    expect(o.notices).toEqual([]);
  });

  it('builds from the named agent, says so, and rejects an unknown name listing default and the configured ones', () => {
    const o = options();
    const ux = createAgent({ system: 'Review the UX.' });
    const built = exploreAgents({ ux }, 'ux', { ...o, notice: (m) => o.notices.push(m) });
    expect(explorerOf(built).executor?.name).toBe('e2e-default-agent');
    expect(built!['ux']).toBe(ux);
    expect(o.notices).toEqual(['exploring with agent "ux"']);
    expect(() => exploreAgents({ ux }, 'uxx', { ...o, notice: () => undefined })).toThrow(
      /unknown agent "uxx"; configured: default, ux; did you mean "ux"\?/,
    );
    expect(() => exploreAgents(undefined, 'nope', { ...o, notice: () => undefined })).toThrow(/unknown agent "nope"; configured: default$/);
  });

  it('leaves an agents value that is not an object to config resolution', () => {
    expect(exploreAgents([] as never, undefined, { ...options(), notice: () => undefined })).toEqual([]);
  });
});
