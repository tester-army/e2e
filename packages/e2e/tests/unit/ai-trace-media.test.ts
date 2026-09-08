import { describe, expect, it } from 'vitest';
import { AiTraceRecorder } from '../../src/internal/ai-trace.ts';

/** Records SDK message parts at both telemetry boundaries without making a model call. */
async function recordMessages(messages: unknown[], rawOutput: unknown = undefined) {
  const recorder = new AiTraceRecorder();
  const telemetry = recorder.telemetry;
  await telemetry.onStart?.({ callId: 'media', operationId: 'ai.generateText' } as never);
  await telemetry.onStepStart?.({
    callId: 'media', stepNumber: 0, provider: 'test', modelId: 'media', messages,
  } as never);
  await telemetry.onLanguageModelCallStart?.({ callId: 'media', messages } as never);
  await telemetry.onStepEnd?.({
    callId: 'media', stepNumber: 0, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
    content: [{ type: 'tool-result', toolName: 'inspect', output: rawOutput }],
    providerMetadata: { test: rawOutput },
    response: { messages },
  } as never);
  await telemetry.onEnd?.({ callId: 'media' } as never);
  const document = recorder.drain();
  recorder.dispose();
  const step = document.steps[0]!;
  return {
    document,
    step,
    input: JSON.parse(step.input) as { prompt: unknown[] },
    output: JSON.parse(step.output!) as {
      content: { output: unknown }[];
      response: { messages: unknown[] };
      providerMetadata: { test: unknown };
    },
  };
}

describe('AI trace inline media', () => {
  it.each([0, 1, 2, 3, 102_400])('records the decoded byte count for %i bytes in SDK content parts', async (size) => {
    const encoded = Buffer.alloc(size, 165).toString('base64');
    const note = `[binary ${size} bytes omitted]`;
    const media = [
      { type: 'file', mediaType: 'image/png', filename: 'capture.png', data: { type: 'data', data: encoded } },
      { type: 'file', mediaType: 'application/pdf', data: encoded },
      { type: 'image', image: encoded },
      { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: encoded } },
      { type: 'image-data', mediaType: 'image/png', data: encoded },
      { type: 'file-data', mediaType: 'application/pdf', data: encoded },
    ];
    const expectedMedia = [
      { type: 'file', mediaType: 'image/png', filename: 'capture.png', data: { type: 'data', data: note } },
      { type: 'file', mediaType: 'application/pdf', data: note },
      { type: 'image', image: note },
      { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: note } },
      { type: 'image-data', mediaType: 'image/png', data: note },
      { type: 'file-data', mediaType: 'application/pdf', data: note },
    ];
    const messages = [
      { role: 'user', content: media.slice(0, 3) },
      { role: 'assistant', content: [media[3]] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'capture', toolName: 'inspect', output: { type: 'content', value: media } }] },
    ];
    const before = JSON.stringify(messages);
    const recorded = await recordMessages(messages);
    const expectedMessages = [
      { role: 'user', content: expectedMedia.slice(0, 3) },
      { role: 'assistant', content: [expectedMedia[3]] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'capture', toolName: 'inspect', output: { type: 'content', value: expectedMedia } }] },
    ];
    expect(recorded.input.prompt).toEqual(expectedMessages);
    expect(recorded.output.response.messages).toEqual(expectedMessages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(Buffer.byteLength(recorded.step.input)).toBeLessThan(2_000);
    expect(Buffer.byteLength(recorded.step.output!)).toBeLessThan(2_000);
    expect(recorded.document.runs).toHaveLength(1);
    expect(recorded.step).toMatchObject({ run_id: recorded.document.runs[0]!.id, type: 'generate', step_number: 1 });
    expect(JSON.parse(recorded.step.usage!)).toEqual({ inputTokens: 1, outputTokens: 1 });
    if (size > 3) {
      expect(recorded.step.input).not.toContain(encoded);
      expect(recorded.step.output).not.toContain(encoded);
    }
  });

  it('counts unpadded and whitespace-separated base64, binary views, and base64 data URLs', async () => {
    const dataUrl = 'data:image/png;base64,Zg==';
    const note = '[binary 1 bytes omitted]';
    const files = ['Zg', ' Z g==\n', Buffer.from([102]), new Uint8Array([102]), new ArrayBuffer(1), dataUrl];
    const content = [
      ...files.map((data) => ({ type: 'file', mediaType: 'image/png', data: { type: 'data', data } })),
      { type: 'image', image: new URL(dataUrl) },
      { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL(dataUrl) } },
      { type: 'image-url', url: dataUrl },
      { type: 'file-url', url: dataUrl, mediaType: 'image/png' },
    ];
    const recorded = await recordMessages([{ role: 'user', content }]);
    const expected = [{
      role: 'user',
      content: [
        ...files.map(() => ({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: note } })),
        { type: 'image', image: note },
        { type: 'file', mediaType: 'image/png', data: { type: 'url', url: note } },
        { type: 'image-url', url: note },
        { type: 'file-url', url: note, mediaType: 'image/png' },
      ],
    }];
    expect(recorded.input.prompt).toEqual(expected);
    expect(recorded.output.response.messages).toEqual(expected);
  });

  it('preserves text, URLs, references, raw tool JSON, and lookalike objects in tool arguments', async () => {
    const encoded = 'ZmlsZSBjb250ZW50';
    const lookalike = { type: 'file', mediaType: 'image/png', data: { type: 'data', data: encoded } };
    const rawOutput = { png: encoded, nested: lookalike, messages: [{ role: 'user', content: [lookalike] }] };
    const url = new URL('https://example.com/image.png');
    const reference = { provider: 'uploaded-file-id' };
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: encoded },
        { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: encoded } },
        { type: 'image', image: url },
        { type: 'image', image: reference },
        { type: 'file', mediaType: 'image/png', data: url },
        { type: 'file', mediaType: 'image/png', data: url.href },
        { type: 'file', mediaType: 'image/png', data: { type: 'url', url } },
        { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference } },
        { type: 'file', mediaType: 'text/plain', data: 'data:text/plain,hello' },
      ] },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'inspect', input: rawOutput }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolName: 'inspect', output: { type: 'json', value: rawOutput } },
        { type: 'tool-result', toolName: 'inspect', output: { type: 'error-json', value: rawOutput } },
        { type: 'tool-result', toolName: 'inspect', output: { type: 'text', value: encoded } },
      ] },
    ];
    const recorded = await recordMessages(messages, rawOutput);
    const expected = JSON.parse(JSON.stringify(messages));
    expect(recorded.input.prompt).toEqual(expected);
    expect(recorded.output.response.messages).toEqual(expected);
    expect(recorded.output.content[0]!.output).toEqual(rawOutput);
    expect(recorded.output.providerMetadata.test).toEqual(rawOutput);
  });
});
