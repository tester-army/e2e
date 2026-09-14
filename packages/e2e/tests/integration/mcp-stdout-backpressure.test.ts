/**
 * `e2e mcp` over a pipe whose reader falls behind. The server's stdout is a
 * non-blocking pipe once Node has set `process.stdout` up, so a protocol
 * stream that wrote the descriptor directly died with EAGAIN as soon as
 * responses outgrew the pipe buffer (a screenshot, a guide resource). The
 * server must queue the writes and stay up until the client drains them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const CONFIG = `import type { E2EConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [{ name: 'web', platform: 'web', engine: playwright({ url: 'http://127.0.0.1:1' }) }],
} satisfies E2EConfig;
`;

/** Well past any pipe buffer: each guide read answers with tens of kilobytes. */
const READS = 40;

describe('e2e mcp stdout backpressure', { timeout: 60_000 }, () => {
  let project: FixtureProject;
  let server: ChildProcessWithoutNullStreams;

  beforeAll(() => {
    project = createProject({ 'e2e.config.ts': CONFIG });
    server = spawn(process.execPath, [CLI, 'mcp', '--headless'], {
      cwd: project.dir,
      env: { ...process.env, CI: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  afterAll(async () => {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
    project.cleanup();
  });

  it('survives responses the client has not read yet, and delivers all of them', async () => {
    let stderr = '';
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const send = (message: Record<string, unknown>): void => {
      server.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'backpressure', version: '0.0.0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    server.stdout.pause();
    for (let index = 0; index < READS; index += 1) {
      send({ jsonrpc: '2.0', id: 100 + index, method: 'resources/read', params: { uri: 'e2e://guide' } });
    }
    await sleep(2_000);
    expect(server.exitCode, `server exited early:\n${stderr}`).toBeNull();

    let output = '';
    server.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.stdout.resume();
    const deadline = Date.now() + 20_000;
    const answered = (): number => output.split('\n').filter((line) => line.includes('"result"') && line.includes('"contents"')).length;
    while (answered() < READS && Date.now() < deadline) await sleep(100);

    expect(server.exitCode).toBeNull();
    expect(answered()).toBe(READS);
    expect(stderr).not.toContain('ERR_SYSTEM_ERROR');
  });
});
