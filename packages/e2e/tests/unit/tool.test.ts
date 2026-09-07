import { describe, expect, it } from 'vitest';
import { defineTool, toolAppliesTo } from '../../src/agent/tool.ts';

const tool = {
  description: 'noop',
  inputSchema: { type: 'object' },
  execute: async () => 'ok',
} as unknown as Parameters<typeof defineTool>[0];

describe('defineTool platforms', () => {
  it('offers an unscoped tool on every platform', () => {
    const defined = defineTool(tool, { mutates: false });
    expect(toolAppliesTo(defined, 'web')).toBe(true);
    expect(toolAppliesTo(defined, 'ios')).toBe(true);
  });

  it('offers a scoped tool only on its declared platforms', () => {
    const defined = defineTool(tool, { mutates: true, platforms: ['ios', 'android'] });
    expect(toolAppliesTo(defined, 'ios')).toBe(true);
    expect(toolAppliesTo(defined, 'web')).toBe(false);
    expect(defined.annotations.platforms).toEqual(['ios', 'android']);
  });

  it('rejects an empty or malformed platforms list', () => {
    expect(() => defineTool(tool, { mutates: false, platforms: [] })).toThrow(/platforms/);
    expect(() => defineTool(tool, { mutates: false, platforms: [''] })).toThrow(/platforms/);
  });
});
