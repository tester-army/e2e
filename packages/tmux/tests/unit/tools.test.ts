import type { ToolExecutionOptions } from 'ai';
import { describe, expect, it } from 'vitest';
import { BackendError } from '@e2edev/e2e/backend';
import { buildBackend } from '../../src/backend.ts';
import { TmuxSurface } from '../../src/surface.ts';
import { tmuxTools } from '../../src/tools.ts';
import { createFakeTmux } from '../helpers/fake-tmux.ts';

async function running() {
  const fake = createFakeTmux();
  const surface = new TmuxSurface({ command: 'opencode', ready: 'Ask anything' }, fake.factory);
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
  return { fake, backend };
}

const options = { toolCallId: 'c1', messages: [], context: undefined } as unknown as ToolExecutionOptions<unknown>;

describe('tmuxTools', () => {
  it('offers send_keys, wait_for_text, and scrollback on the terminal platform only', async () => {
    const { backend } = await running();
    const tools = tmuxTools(backend);
    expect(Object.keys(tools).toSorted()).toEqual(['scrollback', 'send_keys', 'wait_for_text']);
    for (const defined of Object.values(tools)) expect(defined.annotations.platforms).toEqual(['terminal']);
    expect(tools['send_keys']!.annotations).toMatchObject({ mutates: true, replay: 'none', secrets: false });
    expect(tools['wait_for_text']!.annotations).toMatchObject({ mutates: false, replay: 'deterministic' });
    expect(tools['scrollback']!.annotations).toMatchObject({ mutates: false });
  });

  it('dispatches to the running attempt', async () => {
    const { backend, fake } = await running();
    const tools = tmuxTools(backend);
    const sent = await tools['send_keys']!.tool.execute!({ keys: ['/', 'help', 'Enter'] }, options);
    expect(sent).toBe('Sent "/" "help" "Enter".');
    expect(fake.of('send-keys').at(-1)).toEqual(['send-keys', '-t', '@1', '/', 'help', 'Enter']);

    const shown = await tools['wait_for_text']!.tool.execute!({ text: 'ctrl\\+p', regex: true }, options);
    expect(shown).toBe('The screen shows: "tab agents  ctrl+p commands"');

    const history = await tools['scrollback']!.tool.execute!({ lines: 20 }, options);
    expect(fake.of('capture-pane').at(-1)).toEqual(['capture-pane', '-p', '-t', '@1', '-S', '-20']);
    expect(String(history)).toContain('Ask anything');
  });

  it('refuses a foreign backend handle and acting outside an attempt', async () => {
    const { backend } = await running();
    await backend.endAttempt!({ signal: new AbortController().signal, timeoutMs: 1_000 });
    const tools = tmuxTools(backend);
    await expect(tools['send_keys']!.tool.execute!({ keys: ['Enter'] }, options)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    const foreign = { name: 'x', version: '1', spiVersion: 1, capabilities: new Set() };
    expect(() => tmuxTools(foreign as never)).toThrow(BackendError);
  });
});
