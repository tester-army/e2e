import type { Tool, ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { TestError } from '../../src/internal/errors.ts';
import { adaptToolSet, errorResult, resultFromOutput } from '../../src/mcp/tools.ts';

const extra = { signal: new AbortController().signal, progress: () => undefined };

describe('adaptToolSet', () => {
  it('keeps each tool\'s description and schema and runs the live tool through the host', async () => {
    const calls: string[] = [];
    const registration: ToolSet = {
      tap: { description: 'Tap or click one node.', inputSchema: z.object({ target: z.string() }), execute: async () => 'never' },
    };
    const live: ToolSet = {
      tap: { description: 'Tap or click one node.', inputSchema: z.object({ target: z.string() }), execute: async (input: { target: string }) => `Tapped #${input.target}.` },
    };
    const [spec] = adaptToolSet(
      registration,
      async (name, execute) => {
        calls.push(name);
        return execute();
      },
      () => live,
    );
    expect(spec).toMatchObject({ name: 'tap', description: 'Tap or click one node.', readOnly: false });
    expect(spec!.inputSchema).toBe(registration['tap']!.inputSchema);
    await expect(spec!.call({ target: 'n4' }, extra)).resolves.toEqual({ content: [{ type: 'text', text: 'Tapped #n4.' }] });
    expect(calls).toEqual(['tap']);
  });

  it('marks observe read-only and reports a failure as an error result with its code', async () => {
    const tools: ToolSet = {
      observe: {
        description: 'Capture a fresh observation.',
        inputSchema: z.object({}),
        execute: async () => {
          throw new TestError('LOCATOR_NOT_FOUND', 'no observation has been captured yet');
        },
      },
    };
    const [spec] = adaptToolSet(tools, (_name, execute) => execute(), () => tools);
    expect(spec!.readOnly).toBe(true);
    await expect(spec!.call({}, extra)).resolves.toEqual({
      content: [{ type: 'text', text: 'LOCATOR_NOT_FOUND: no observation has been captured yet' }],
      isError: true,
    });
  });

  it('refuses a tool the live session does not offer', async () => {
    const tools: ToolSet = { navigate: { description: 'Navigate.', inputSchema: z.object({ url: z.string() }), execute: async () => 'ok' } };
    const [spec] = adaptToolSet(tools, (_name, execute) => execute(), () => ({}));
    const result = await spec!.call({ url: '/' }, extra);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'UNSUPPORTED_CAPABILITY: tool "navigate" is not available in this session' });
  });
});

describe('resultFromOutput', () => {
  const plain: Tool = { description: 'x', inputSchema: z.object({}) };

  it('passes text through and serializes structured output as JSON', () => {
    expect(resultFromOutput(plain, 'Done.')).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
    expect(resultFromOutput(plain, { ok: true })).toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }] });
    expect(resultFromOutput(plain, undefined)).toEqual({ content: [{ type: 'text', text: 'Done.' }] });
  });

  it('renders a toModelOutput file part as an image, the way the device screenshot tool does', () => {
    const screenshot: Tool = {
      ...plain,
      toModelOutput: ({ output }) =>
        (output as { png?: string }).png === undefined
          ? { type: 'text', value: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }
          : { type: 'content', value: [{ type: 'file', data: { type: 'data', data: (output as { png: string }).png }, mediaType: 'image/png' }] as never },
    };
    expect(resultFromOutput(screenshot, { png: 'AAAA' })).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    expect(resultFromOutput(screenshot, { withheld: 'UNSUPPORTED_CAPABILITY' })).toEqual({
      content: [{ type: 'text', text: 'Screenshot withheld: UNSUPPORTED_CAPABILITY' }],
    });
  });
});

describe('errorResult', () => {
  it('prefixes runner errors with their code and leaves foreign errors as their message', () => {
    expect(errorResult(new TestError('ACTION_FAILED', 'covered'))).toEqual({ content: [{ type: 'text', text: 'ACTION_FAILED: covered' }], isError: true });
    expect(errorResult(new Error('boom'))).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});
