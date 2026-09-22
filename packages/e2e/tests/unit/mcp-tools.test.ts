import type { Tool, ToolSet } from 'ai';
import { z } from 'zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { createGrammarTools } from '../../src/agent/primitives.ts';
import { TestError } from '../../src/internal/errors.ts';
import { catalogLine, describeToolDetail, errorResult, invokeTool, resultFromOutput, toolJsonSchema } from '../../src/mcp/tools.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';

const extra = { signal: new AbortController().signal };

// The catalog renders synchronously off the loaded SDK, as it does after the session host primes it.
beforeAll(() => loadAiSdk());

const tap: ToolSet[string] = {
  description: 'Tap or click one node. The result waits for the effect and reports what changed.',
  inputSchema: z.object({ target: z.string().min(1).describe('Node id'), times: z.number().int().optional() }),
  execute: async (input: { target: string }) => `Tapped #${input.target}.`,
};

describe('catalogLine', () => {
  it('shows the name, the argument names with optional ones marked, and the first sentence', () => {
    expect(catalogLine('tap', tap, false)).toBe('- tap {target, times?}: Tap or click one node.');
  });

  it('omits the braces for a tool without arguments and marks a read-only tool', () => {
    const observe: ToolSet[string] = { description: 'Look at the whole current screen: every node.', inputSchema: z.object({}), execute: async () => 'screen' };
    expect(catalogLine('observe', observe, true)).toBe('- observe: Look at the whole current screen: every node. [read-only]');
  });

  it('does not end the sentence at an abbreviation', () => {
    const press: ToolSet[string] = { description: 'Send one key (e.g. "Enter", "Escape", "Tab") to one node. More text.', inputSchema: z.object({ key: z.string() }), execute: async () => 'ok' };
    expect(catalogLine('press', press, false)).toBe('- press {key}: Send one key (e.g. "Enter", "Escape", "Tab") to one node.');
  });

  it('falls back to the name when a tool has no description and bounds a run-on sentence', () => {
    const bare: ToolSet[string] = { inputSchema: z.object({}), execute: async () => 'ok' };
    expect(catalogLine('bare', bare, false)).toBe('- bare: bare');
    const long: ToolSet[string] = { description: `${'word '.repeat(60)}end`, inputSchema: z.object({}), execute: async () => 'ok' };
    const line = catalogLine('long', long, false);
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('describeToolDetail and toolJsonSchema', () => {
  it('renders the full description and the JSON Schema without the draft marker', () => {
    const detail = describeToolDetail('tap', tap, false);
    expect(detail).toContain('Tap or click one node. The result waits for the effect and reports what changed.');
    expect(detail).toContain('Arguments (JSON Schema):');
    expect(detail).not.toContain('$schema');
    expect(toolJsonSchema(tap)).toMatchObject({
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string', description: 'Node id' }, times: { type: 'integer' } },
    });
  });
});

describe('invokeTool', () => {
  it('validates the arguments against the tool schema and runs the tool', async () => {
    await expect(invokeTool('tap', tap, { target: 'n4' }, extra)).resolves.toEqual({ content: [{ type: 'text', text: 'Tapped #n4.' }] });
  });

  it('rejects wrong arguments before the tool runs, naming the field and pointing at tools', async () => {
    let ran = false;
    const guarded: ToolSet[string] = {
      ...tap,
      execute: async () => {
        ran = true;
        return 'never';
      },
    };
    await expect(invokeTool('tap', guarded, { target: 5 }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/^call tap: target: .*; tools \{tool: "tap"\} shows its arguments$/),
    });
    await expect(invokeTool('tap', guarded, {}, extra)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ran).toBe(false);
  });

  it('refuses an argument a grammar tool does not declare, before anything is dispatched', async () => {
    const { context, dispatched } = fakeExecutorContext();
    const grammar = createGrammarTools(context);
    await expect(invokeTool('tap', grammar['tap']!, { target: 'n4', force: true }, extra)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'call tap: Unrecognized key: "force"; tools {tool: "tap"} shows its arguments',
    });
    expect(dispatched).toEqual([]);
  });

  it('lets a tool failure propagate with its code, for the host to render', async () => {
    const failing: ToolSet[string] = {
      description: 'Capture a fresh observation.',
      inputSchema: z.object({}),
      execute: async () => {
        throw new TestError('LOCATOR_NOT_FOUND', 'no observation has been captured yet');
      },
    };
    await expect(invokeTool('observe', failing, {}, extra)).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });

  it('refuses a tool without an execute function', async () => {
    const inert: ToolSet[string] = { description: 'x', inputSchema: z.object({}) };
    await expect(invokeTool('inert', inert, {}, extra)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('resultFromOutput', () => {
  const plain: Tool = { description: 'x', inputSchema: z.object({}) };

  it('passes text through and serializes structured output as JSON', async () => {
    expect(await resultFromOutput(plain, 'Done.')).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
    expect(await resultFromOutput(plain, { ok: true })).toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
    expect(await resultFromOutput(plain, undefined)).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
  });

  it('renders a toModelOutput file part as an image, the way the device screenshot tool does', async () => {
    const screenshot: Tool = {
      ...plain,
      toModelOutput: ({ output }) =>
        (output as { png?: string }).png === undefined
          ? { type: 'text', value: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }
          : { type: 'content', value: [{ type: 'file', data: { type: 'data', data: (output as { png: string }).png }, mediaType: 'image/png' }] },
    };
    expect(await resultFromOutput(screenshot, { png: 'AAAA' })).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    expect(await resultFromOutput(screenshot, { withheld: 'UNSUPPORTED_CAPABILITY' })).toEqual({
      content: [{ type: 'text', text: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }],
    });
  });

  it('hands the call arguments to a renderer that reads its input', async () => {
    const echo: Tool = {
      description: 'x',
      inputSchema: z.object({ label: z.string() }),
      toModelOutput: ({ input, output }) => ({ type: 'text', value: `${(input as { label: string }).label}: ${String(output)}` }),
    };
    expect(await resultFromOutput(echo, 42, { label: 'answer' })).toEqual({ content: [{ type: 'text', text: 'answer: 42' }] });
  });
});

describe('errorResult', () => {
  it('prefixes runner errors with their code and leaves foreign errors as their message', () => {
    expect(errorResult(new TestError('ACTION_FAILED', 'covered'))).toEqual({ content: [{ type: 'text', text: 'ACTION_FAILED: covered' }], isError: true });
    expect(errorResult(new Error('boom'))).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});
