import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { ManagedProcess } from '../../src/run/managed-process.ts';
import { freePort } from '../helpers/free-port.ts';

const SERVER_SCRIPT = `
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); });
  server.listen(Number(process.argv[1]), '127.0.0.1');
  // Ignore SIGTERM to prove the runner escalates to SIGKILL.
  if (process.argv[2] === 'ignore-sigterm') process.on('SIGTERM', () => {});
`;

function nodeApp(
  port: number,
  options: { extraArg?: string; startupTimeout?: number; reuseExisting?: boolean } = {},
) {
  return new ManagedProcess(
    'app.command',
    {
      executable: process.execPath,
      args: ['-e', SERVER_SCRIPT, String(port), ...(options.extraArg ? [options.extraArg] : [])],
      startupTimeout: options.startupTimeout ?? 15_000,
      shutdownTimeout: 2_000,
      ...(options.reuseExisting === undefined ? {} : { reuseExisting: options.reuseExisting }),
    },
    os.tmpdir(),
    { readyUrl: `http://127.0.0.1:${port}/` },
  );
}

async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

describe('ManagedProcess', () => {
  it('starts the app, waits for readiness, and stops the process group, idempotently and safely before start', async () => {
    const port = await freePort();
    const app = nodeApp(port);
    await app.stop();
    await app.start();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    await app.stop();
    await app.stop();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it('escalates to SIGKILL when the app ignores SIGTERM', async () => {
    const port = await freePort();
    const app = nodeApp(port, { extraArg: 'ignore-sigterm' });
    await app.start();
    const stoppedAt = Date.now();
    await app.stop();
    // shutdownTimeout (2s) + kill; anything much longer means the escalation hung.
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('stops a surviving child after the command leader exits on SIGTERM', async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-process-group-'));
    const pidFile = path.join(dir, 'child.pid');
    const wrapper = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(SERVER_SCRIPT)}, '${port}', 'ignore-sigterm'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', wrapper],
      shutdownTimeout: 100,
    }, dir, { readyUrl: `http://127.0.0.1:${port}/` });
    try {
      await app.start();
      await app.stop();
      expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
      await app.stop();
    } finally {
      await app.stop();
      // Also release the owned descendant when the regression runs before the fix.
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('lets a child finish its shutdown after the leader exits', async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-process-grace-'));
    const pidFile = path.join(dir, 'child.pid');
    const finished = path.join(dir, 'finished');
    const server = `
      const fs = require('node:fs');
      require('node:http').createServer((req, res) => res.end('ok')).listen(${port}, '127.0.0.1');
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(finished)}, 'finished');
        process.exit(0);
      }, 50));
    `;
    const wrapper = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', wrapper],
      shutdownTimeout: 1_000,
    }, dir, { readyUrl: `http://127.0.0.1:${port}/` });
    try {
      await app.start();
      await app.stop();
      expect(fs.readFileSync(finished, 'utf8')).toBe('finished');
      expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
    } finally {
      await app.stop();
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with APP_UNREACHABLE when the command exits before becoming ready', async () => {
    const port = await freePort();
    const app = new ManagedProcess(
      'app.command',
      { executable: process.execPath, args: ['-e', 'process.exit(3)'] },
      os.tmpdir(),
      { readyUrl: `http://127.0.0.1:${port}/` },
    );
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('exited with code 3');
  });

  it('fails with APP_UNREACHABLE when the executable cannot spawn', async () => {
    const port = await freePort();
    const app = new ManagedProcess(
      'app.command',
      { executable: '/definitely/not/a/real/binary' },
      os.tmpdir(),
      { readyUrl: `http://127.0.0.1:${port}/` },
    );
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('failed to start');
  });

  it('times out and cleans up when the app never becomes ready', async () => {
    const port = await freePort();
    const app = new ManagedProcess(
      'app.command',
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        startupTimeout: 500,
        shutdownTimeout: 2_000,
      },
      os.tmpdir(),
      { readyUrl: `http://127.0.0.1:${port}/` },
    );
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).message).toContain('was not reachable');
  }, 20_000);

  it('with reuseExisting, starts and owns the app when nothing answers at readyUrl yet', async () => {
    const port = await freePort();
    const app = nodeApp(port, { reuseExisting: true });
    await app.start();
    expect(app.spawned).toBe(true);
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    await app.stop();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

});
