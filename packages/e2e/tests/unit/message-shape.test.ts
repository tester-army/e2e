import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { shapeOf } from '../../src/agent/message-shape.ts';

const bytes = () => new Uint8Array([137, 80, 78, 71]);

const screenshot = (): ModelMessage => ({
  role: 'user',
  content: [
    { type: 'text', text: 'Execute this test step: look.' },
    { type: 'file', data: bytes(), mediaType: 'image/png' },
  ],
});

const result = (value: string): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'tap', output: { type: 'text', value } }],
});

describe('message shapes', () => {
  it('match for a clone of the same message, bytes included', () => {
    const message = screenshot();
    expect(shapeOf(structuredClone(message))).toBe(shapeOf(message));
  });

  it('read a Buffer by its bytes, like the plain array it holds', () => {
    const buffered: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Execute this test step: look.' },
        { type: 'file', data: Buffer.from(bytes()), mediaType: 'image/png' },
      ],
    };
    expect(shapeOf(buffered)).toBe(shapeOf(screenshot()));
  });

  it('ignore provider options, where a cache breakpoint moves and a signature rides', () => {
    const plain: ModelMessage = { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'ok' }] };
    const marked: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'sig' } } },
        { type: 'text', text: 'ok', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      ],
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    };
    expect(shapeOf(marked)).toBe(shapeOf(plain));
  });

  it('differ when a text, a tool result below its part, or the role changes', () => {
    const before = shapeOf(result('looked'));
    expect(shapeOf(result('looked again'))).not.toBe(before);
    const edited = result('looked');
    (edited.content[0] as { output: unknown }).output = { type: 'text', value: 'looked [edited]' };
    expect(shapeOf(edited)).not.toBe(before);
    expect(shapeOf({ role: 'user', content: 'x' })).not.toBe(shapeOf({ role: 'assistant', content: 'x' }));
  });

  it('are taken from the bytes, so an edit to the live array after the snapshot shows', () => {
    const message = screenshot();
    const before = shapeOf(message);
    const data = (message.content as { data: Uint8Array }[])[1]!.data;
    data[0] = 0;
    expect(shapeOf(message)).not.toBe(before);
    expect(shapeOf(screenshot())).toBe(before);
  });

  it('differ for payloads of another length or content, and for a file named by URL against one sent as bytes', () => {
    const shorter: ModelMessage = { role: 'user', content: [{ type: 'file', data: new Uint8Array([137, 80, 78]), mediaType: 'image/png' }] };
    const byUrl = (): ModelMessage => ({ role: 'user', content: [{ type: 'file', data: new URL('https://example.test/a.png'), mediaType: 'image/png' }] });
    const screenshotShape = shapeOf({ role: 'user', content: [{ type: 'file', data: bytes(), mediaType: 'image/png' }] });
    expect(shapeOf(shorter)).not.toBe(screenshotShape);
    expect(shapeOf(byUrl())).not.toBe(screenshotShape);
    expect(shapeOf(byUrl())).toBe(shapeOf(byUrl()));
  });
});
