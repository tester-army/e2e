import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { ManagedProcess } from '../../src/run/managed-process.ts';
import { freePort } from '../helpers/free-port.ts';

/** Whether the operating system still sees the managed child. */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('ManagedProcess exit during readiness', () => {
  it('rejects a successful readiness response when the command exited while the probe was pending', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-readiness-exit-'));
    const pidFile = path.join(dir, 'pid');
    const unexpectedExit = vi.fn();
    const ready = vi.fn();
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      probes += 1;
      if (probes === 1) return new Response('', { status: 503 });
      await expect.poll(() => existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      process.kill(pid, 'SIGTERM');
      await expect.poll(() => processRunning(pid)).toBe(false);
      return new Response('ready');
    }));
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);"],
      startupTimeout: 5000,
      shutdownTimeout: 1000,
    }, dir, { readyUrl: 'http://127.0.0.1:1/' }, { ready, unexpectedExit });
    try {
      const failure: unknown = await app.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect(failure).toMatchObject({ code: 'APP_UNREACHABLE', message: expect.stringContaining('before becoming ready') });
      expect(ready).not.toHaveBeenCalled();
      expect(unexpectedExit).not.toHaveBeenCalled();
    } finally {
      await app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report the runner stopping a ready command as an unexpected exit', async () => {
    const port = await freePort();
    const unexpectedExit = vi.fn();
    const ready = vi.fn();
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', `require('node:http').createServer((_request, response) => response.end('ready')).listen(${port}, '127.0.0.1');`],
      startupTimeout: 5000,
      shutdownTimeout: 1000,
    }, process.cwd(), { readyUrl: `http://127.0.0.1:${port}/` }, { ready, unexpectedExit });
    try {
      await app.start();
      expect(ready).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
    expect(unexpectedExit).not.toHaveBeenCalled();
  });
});
