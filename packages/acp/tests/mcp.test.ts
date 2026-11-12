/** Forwarding failures stay off HTTP while the owning session retains their cause. */
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveTools, type ToolServer } from '../src/mcp.ts';
import { startSession, type AcpSession } from '../src/session.ts';

const state = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  stream: false,
  controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
  cancelled: false,
}));

vi.mock('@modelcontextprotocol/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return {
    ...actual,
    createMcpHandler: (...args: Parameters<typeof actual.createMcpHandler>) => {
      const handler = actual.createMcpHandler(...args);
      return {
        ...handler,
        fetch: async (request: Request) => {
          if (state.stream) {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                state.controller = controller;
                controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
              },
              cancel() { state.cancelled = true; },
            }), { headers: { 'content-type': 'text/event-stream' } });
          }
          if (state.error !== undefined) throw state.error;
          return handler.fetch(request);
        },
      };
    },
  };
});

const servers: ToolServer[] = [];
const sessions: AcpSession[] = [];
const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const launch = { command: process.execPath, args: [AGENT], env: { ACP_SCRIPT: '[[{"call":"observe"}]]' } };

beforeEach(() => {
  state.error = undefined;
  state.stream = false;
  state.controller = undefined;
  state.cancelled = false;
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const server of servers.splice(0)) await server.close();
});

describe('step-tool forwarding diagnostics', () => {
  it('sends a generic response and retains the original local failure', async () => {
    const error = new Error('cannot read synthetic-server-secret-271828');
    state.error = error;
    const server = await serveTools([]);
    servers.push(server);
    const response = await fetch(server.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal server error');
    await expect(server.failed).rejects.toMatchObject({
      message: `step-tool request forwarding failed: ${error.message}`,
      cause: error,
    });
  });

  it('retains an asynchronous response-stream error without sending its text', async () => {
    state.stream = true;
    const server = await serveTools([]);
    servers.push(server);
    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: ready\n\n');
    const error = Object.assign(new Error('stream failed with synthetic-server-secret-314159'), { code: 'ECONNRESET' });
    state.controller!.error(error);
    await expect(server.failed).rejects.toMatchObject({ cause: error });
    await expect(reader.read()).rejects.toThrow();
  });

  it('cancels the response stream without failing the session when the client disconnects', async () => {
    state.stream = true;
    const server = await serveTools([]);
    servers.push(server);
    let failure: unknown;
    void server.failed.catch(error => { failure = error; });
    const controller = new AbortController();
    const response = await fetch(server.url, { signal: controller.signal });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
    await setImmediate();
    expect(failure).toBeUndefined();
  });

  it('propagates a forwarding failure during agent startup', async () => {
    const error = new Error('startup forwarding failed');
    state.error = error;
    await expect(startSession(launch, [], new AbortController().signal)).rejects.toMatchObject({
      message: `step-tool request forwarding failed: ${error.message}`,
      cause: error,
    });
  });

  it('interrupts an active agent turn with the forwarding cause', async () => {
    const session = await startSession(launch, [], new AbortController().signal);
    sessions.push(session);
    const error = new Error('active forwarding failed');
    state.error = error;
    await expect(session.prompt('try observe')).rejects.toMatchObject({
      message: `step-tool request forwarding failed: ${error.message}`,
      cause: error,
    });
  });
});
