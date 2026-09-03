import { describe, expect, it } from 'vitest';
import { defineTool, toolAppliesTo } from '../../src/agent/tool.ts';

const tool = {
  description: 'noop',
  inputSchema: { type: 'object' },
  execute: async () => 'ok',
} as unknown as Parameters<typeof defineTool>[0];

describe('defineTool platforms', () => {
  it('offers an unscoped tool on every platform', () => {
    const defined = defineTool(tool, { replay: 'none', mutates: false, secrets: false });
    expect(toolAppliesTo(defined, 'web')).toBe(true);
    expect(toolAppliesTo(defined, 'ios')).toBe(true);
  });

  it('offers a scoped tool only on its declared platforms', () => {
    const defined = defineTool(tool, {
      replay: 'deterministic',
      mutates: true,
      secrets: false,
      platforms: ['ios', 'android'],
    });
    expect(toolAppliesTo(defined, 'ios')).toBe(true);
    expect(toolAppliesTo(defined, 'web')).toBe(false);
    expect(defined.annotations.platforms).toEqual(['ios', 'android']);
  });

  it('rejects an empty or malformed platforms list', () => {
    expect(() =>
      defineTool(tool, { replay: 'none', mutates: false, secrets: false, platforms: [] }),
    ).toThrow(/platforms/);
    expect(() =>
      defineTool(tool, { replay: 'none', mutates: false, secrets: false, platforms: [''] }),
    ).toThrow(/platforms/);
  });
});

describe('defineTool replay tiers (RFC0003)', () => {
  it('accepts the deterministic and none string sugar, normalizing to the object form', () => {
    expect(defineTool(tool, { replay: 'deterministic', mutates: false, secrets: false }).annotations.replay).toEqual({
      mode: 'deterministic',
    });
    expect(defineTool(tool, { replay: 'none', mutates: true, secrets: false }).annotations.replay).toEqual({
      mode: 'none',
    });
  });

  it('accepts the located tier with concrete input paths', () => {
    const defined = defineTool(tool, {
      replay: { mode: 'located', locate: ['target', 'anchor'] },
      mutates: false,
      secrets: false,
    });
    expect(defined.annotations.replay).toEqual({ mode: 'located', locate: ['target', 'anchor'] });
  });

  it('rejects a located tier with no paths, blank paths, duplicates, or a sparse array', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const sparse: string[] = [, 'a'] as string[];
    for (const locate of [[], [''], ['  '], ['a', 'a'], sparse]) {
      expect(() =>
        defineTool(tool, { replay: { mode: 'located', locate }, mutates: false, secrets: false }),
      ).toThrow(/locate/);
    }
  });

  it('accepts a fixed-model tier only on a non-mutating tool', () => {
    expect(
      defineTool(tool, { replay: { mode: 'fixed-model' }, mutates: false, secrets: false }).annotations.replay,
    ).toEqual({ mode: 'fixed-model' });
    expect(() =>
      defineTool(tool, { replay: { mode: 'fixed-model' }, mutates: true, secrets: false }),
    ).toThrow(/fixed-model/);
  });

  it('rejects an unknown tier and a malformed replay value', () => {
    expect(() =>
      defineTool(tool, { replay: { mode: 'sometimes' } as never, mutates: false, secrets: false }),
    ).toThrow(/unknown replay tier/);
    expect(() =>
      defineTool(tool, { replay: 42 as never, mutates: false, secrets: false }),
    ).toThrow(/replay/);
  });
});
