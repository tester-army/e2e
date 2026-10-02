/**
 * The `e2e mcp` telemetry wiring against a real server over in-memory
 * streams: a session's event names the client from `initialize` and leaves
 * as soon as the session ends, before the flush at exit, and the protocol
 * stream carries nothing but protocol.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionTelemetry } from '../../src/cli/mcp.ts';
import { serveMcp } from '../../src/mcp/server.ts';
import { EVENT_MCP_SESSION } from '../../src/telemetry/events.ts';
import { Telemetry } from '../../src/telemetry/telemetry.ts';

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-telemetry-'));
  temporaries.push(dir);
  return dir;
}

describe('e2e mcp telemetry', () => {
  it('sends each session as it ends, named after the client that opened it', async () => {
    const cwd = tempDir();
    const debug: string[] = [];
    const telemetry = new Telemetry({
      version: '1.2.3',
      env: { E2E_TELEMETRY_DEBUG: '1' },
      cwd,
      configDir: tempDir(),
      write: (text) => void debug.push(text),
      projectId: async () => undefined,
    });
    telemetry.session('mcp', []);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: string[] = [];
    stdout.on('data', (chunk: Buffer) => frames.push(...chunk.toString().split('\n').filter((line) => line !== '')));
    const served = serveMcp({
      cwd,
      headed: false,
      env: {},
      version: '1.2.3',
      stdin,
      stdout,
      log: () => undefined,
      onSessionEnd: sessionTelemetry(telemetry),
    });
    const send = (message: Record<string, unknown>): void => void stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'open_session', arguments: { config: 'acme/missing.config.ts' } } });

    const events = () =>
      debug.flatMap((text) => text.split('\n')).filter((line) => line.startsWith('[telemetry] ')).map((line) => JSON.parse(line.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    const [event] = events();
    expect(event!.event).toBe(EVENT_MCP_SESSION);
    expect(event!.properties).toMatchObject({ client: 'claude-code', client_version: '2.1.0', outcome: 'open-failed', error_code: 'CONFIG_NOT_FOUND' });
    expect(JSON.stringify(event)).not.toContain('acme');

    stdin.end();
    await served;
    await telemetry.flush();
    expect(events().map((item) => item.event)).toEqual([EVENT_MCP_SESSION, 'e2e_cli_session']);
    for (const frame of frames) expect(JSON.parse(frame)).toMatchObject({ jsonrpc: '2.0' });
  });
});
