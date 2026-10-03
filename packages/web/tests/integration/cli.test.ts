/**
 * The built `e2e-web` command as a user runs it: a real process spawning the
 * pinned Playwright CLI. The download host is a local server that accepts and
 * never answers, so a cancelled install is observable without the network.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '../../dist/bin.js');

/** Spawns the command with `args` and the given extra environment. */
function runBin(args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [BIN, ...args], { stdio: 'ignore', env: { ...process.env, ...env } });
}

/** Resolves with the exit code and signal once `child` exits. */
function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('e2e-web', () => {
  it('exits 0 when the browser is already installed', async () => {
    expect(await exited(runBin(['install', 'chromium']))).toEqual({ code: 0, signal: null });
  });

  it('ends the download when the command gets SIGTERM, and exits 143', async () => {
    const browsers = mkdtempSync(path.join(tmpdir(), 'e2e-web-cli-'));
    const sockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      sockets.push(socket);
      socket.resume();
    });
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(browsers, { recursive: true, force: true });
    });
    const connected = new Promise<Socket>((resolve) => server.once('connection', resolve));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');

    const child = runBin(['install', 'chromium'], {
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      PLAYWRIGHT_DOWNLOAD_HOST: `http://127.0.0.1:${String(address.port)}`,
    });
    const download = await connected;
    const downloadClosed = new Promise<void>((resolve) => download.once('close', () => resolve()));
    child.kill('SIGTERM');

    expect(await exited(child)).toEqual({ code: 143, signal: null });
    await downloadClosed;
  });
});
