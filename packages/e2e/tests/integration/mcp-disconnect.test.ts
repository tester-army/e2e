/**
 * `e2e mcp` when its client goes away: the built CLI over raw stdio pipes, on
 * a project whose app is an app command the server starts. A client that
 * closes stdin, or dies and takes both pipes with it, must leave nothing
 * behind: the server closes its sessions, stops the app, and exits 0.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freePort } from '../helpers/free-port.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** The app command: writes its pid, serves a page at `/`, and one at `/slow` that answers after a while. */
const APP = `const { writeFileSync } = require('node:fs');
writeFileSync('app.pid', String(process.pid));
require('node:http').createServer((request, response) => {
  const page = () => response.end('<!doctype html><title>App</title><button>Go</button>');
  if (request.url === '/slow') setTimeout(page, 1_500);
  else page();
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

const config = (port: number): string => `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: {
    url: 'http://127.0.0.1:${port}',
    command: { executable: process.execPath, args: ['app.cjs', '${port}'] },
  } }],
} satisfies E2EConfig;
`;

interface Deferred {
  readonly promise: Promise<Record<string, unknown>>;
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('e2e mcp when the client goes away', { timeout: 90_000 }, () => {
  let project: FixtureProject;
  let server: ChildProcessWithoutNullStreams;
  let stderr: string;
  /** Responses by request id, each settled when its line arrives or rejected when the server exits first. */
  let responses: Map<number, Deferred>;

  const send = (message: Record<string, unknown>): void => {
    server.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const pending = (id: number): Deferred => {
    let entry = responses.get(id);
    if (entry === undefined) {
      let resolve!: Deferred['resolve'];
      let reject!: Deferred['reject'];
      const promise = new Promise<Record<string, unknown>>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
      // A request nobody awaits (the call a dying client left in flight) must not reject unhandled.
      promise.catch(() => undefined);
      entry = { promise, resolve, reject };
      responses.set(id, entry);
    }
    return entry;
  };

  /** Resolves with the response to request `id`. */
  const response = (id: number): Promise<Record<string, unknown>> => pending(id).promise;

  const exited = (): Promise<number | null> =>
    server.exitCode !== null ? Promise.resolve(server.exitCode) : new Promise((resolve) => server.once('exit', (code) => resolve(code)));

  /** The exit code, or `'running'` when the server outlives `ms`. */
  const exitWithin = (ms: number): Promise<number | null | 'running'> => Promise.race([exited(), sleep(ms).then(() => 'running' as const)]);

  const appPid = (): number | undefined => {
    const file = path.join(project.dir, 'app.pid');
    return existsSync(file) ? Number.parseInt(readFileSync(file, 'utf8'), 10) : undefined;
  };

  beforeEach(async () => {
    project = createProject({ 'e2e.config.ts': config(await freePort()), 'app.cjs': APP });
    stderr = '';
    responses = new Map();
    server = spawn(process.execPath, [CLI, 'mcp', '--headless'], {
      cwd: project.dir,
      env: { ...process.env, CI: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let buffered = '';
    server.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message['id'] === 'number') pending(message['id']).resolve(message);
      }
    });
    server.once('exit', () => {
      for (const entry of responses.values()) entry.reject(new Error(`the server exited; stderr:\n${stderr}`));
    });
    // The client end of a pipe the server writes after the client is gone.
    server.stdout.on('error', () => undefined);
    server.stdin.on('error', () => undefined);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'disconnect', version: '0.0.0' } },
    });
    await response(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  afterEach(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exited();
    }
    // An app the server left behind is the failure under test; never leave it running.
    const pid = appPid();
    if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    project.cleanup();
  });

  const openSession = async (): Promise<void> => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_session', arguments: {} } });
    const opened = (await response(2)) as { result?: { isError?: boolean; content: { text: string }[] } };
    expect(opened.result?.isError, JSON.stringify(opened)).not.toBe(true);
  };

  it('exits 0 when the client closes stdin with no session open', async () => {
    server.stdin.end();
    expect(await exitWithin(10_000)).toBe(0);
    expect(stderr).not.toContain('unsettled top-level await');
  });

  it('closes the open session, stops the app, and exits 0 when the client closes stdin', async () => {
    await openSession();
    const pid = appPid();
    expect(pid !== undefined && alive(pid)).toBe(true);

    server.stdin.end();
    expect(await exitWithin(20_000), stderr).toBe(0);
    expect(alive(pid!)).toBe(false);
    expect(stderr).toContain('client disconnected');
  });

  it('closes the session, stops the app, and exits 0 when the client dies with a call in flight', async () => {
    await openSession();
    const pid = appPid();
    expect(pid !== undefined && alive(pid)).toBe(true);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call', arguments: { tool: 'navigate', args: { url: '/slow' } } } });
    // A killed client takes every pipe with it, stderr included: the answer
    // to the call and the diagnostics of the shutdown have nowhere to go.
    server.stdout.destroy();
    server.stdin.destroy();
    server.stderr.destroy();

    expect(await exitWithin(20_000)).toBe(0);
    expect(alive(pid!)).toBe(false);
  });
});
