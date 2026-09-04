import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '@e2edev/e2e/backend';
import { createFakeTransport, sdkMock, text, toolApproval, toolOutput } from '../helpers/fake-transport.ts';

vi.mock('ai', () => ({ ...sdkMock(), tool: (config: unknown) => config }));

const { buildBackend } = await import('../../src/backend.ts');
const { ConversationSurface } = await import('../../src/surface.ts');
const { conversationTools } = await import('../../src/tools.ts');

async function running() {
  const transport = createFakeTransport();
  const surface = new ConversationSurface({ transport, name: 'support' });
  const backend = buildBackend(surface);
  await backend.init!({
    runId: 'r',
    targetName: 't',
    projectRoot: '/p',
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
  await backend.startAttempt!({ attemptId: 'a', artifactsDir: '/tmp/none', signal: new AbortController().signal });
  return { transport, backend };
}

const options = { toolCallId: 'c1', messages: [] } as unknown as Parameters<NonNullable<ReturnType<typeof conversationTools>['send_message']['tool']['execute']>>[1];

describe('conversationTools', () => {
  it('offers send_message and respond_to_approval on the conversation platform only', async () => {
    const { backend } = await running();
    const tools = conversationTools(backend);
    expect(Object.keys(tools).toSorted()).toEqual(['respond_to_approval', 'send_message']);
    for (const defined of Object.values(tools)) {
      expect(defined.annotations.platforms).toEqual(['conversation']);
      expect(defined.annotations).toMatchObject({ mutates: true, replay: 'none', secrets: false });
    }
  });

  it('send_message reports the reply, and the approval flow runs through the pack', async () => {
    const { backend, transport } = await running();
    const tools = conversationTools(backend);

    transport.reply([text('Hi, I can help with that.')]);
    const sent = await tools['send_message']!.tool.execute!({ text: 'hello' }, options);
    expect(String(sent)).toContain('Hi, I can help with that.');

    transport.reply([toolApproval('wire', { to: 'Bob', amount: 50 })]);
    const paused = await tools['send_message']!.tool.execute!({ text: 'wire $50 to Bob' }, options);
    expect(String(paused)).toContain('waiting for approval');

    transport.reply([toolOutput('wire', { to: 'Bob', amount: 50 }, { ok: true }), text('Sent.')]);
    const resumed = await tools['respond_to_approval']!.tool.execute!({ approved: true }, options);
    expect(String(resumed)).toContain('Approved');
    expect(String(resumed)).toContain('Sent.');
  });

  it('refuses a foreign handle', () => {
    const foreign = { name: 'x', version: '1', spiVersion: 1, capabilities: new Set() };
    expect(() => conversationTools(foreign as never)).toThrow(BackendError);
  });
});
