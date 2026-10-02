import type { ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { catalogLine, invokeTool, toolJsonSchema } from '../../src/mcp/tools.ts';

// A project that never installed the optional `ai` peer.
vi.mock('ai', () => {
  throw new Error("Cannot find package 'ai'");
});

const extra = { signal: new AbortController().signal };

const tap: ToolSet[string] = {
  description: 'Tap or click one node. The result waits for the effect and reports what changed.',
  inputSchema: z.object({ target: z.string().min(1).describe('Node id'), times: z.number().int().optional() }),
  execute: async (input: { target: string }) => `Tapped #${input.target}.`,
};

describe('the MCP catalog without the ai package', () => {
  it('is the precondition: the SDK cannot load', async () => {
    await expect(loadAiSdk()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('renders a zod tool from its Standard Schema', () => {
    expect(catalogLine('tap', tap, false)).toBe('- tap {target, times?}: Tap or click one node.');
    expect(toolJsonSchema(tap)).toMatchObject({
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string', description: 'Node id' }, times: { type: 'integer' } },
    });
    expect(toolJsonSchema(tap)).not.toHaveProperty('$schema');
  });

  it('validates and runs a zod tool', async () => {
    const result = await invokeTool('tap', tap, { target: 'n1' }, extra);
    expect(result.content).toEqual([{ type: 'text', text: 'Tapped #n1.' }]);
    await expect(invokeTool('tap', tap, { target: '' }, extra)).rejects.toThrow(/call tap: target: .+tools \{tool: "tap"\}/);
  });
});
