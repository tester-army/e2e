import os from 'node:os';
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
  it('starts the app, waits for readiness, and stops the process group', async () => {
    const port = await freePort();
    const app = nodeApp(port);
    await app.start();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    await app.stop();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it('stop is idempotent and safe before start', async () => {
    const port = await freePort();
    const app = nodeApp(port);
    await app.stop();
    await app.start();
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
        startupTimeout: 1_500,
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

  it('without reuseExisting, a server another process already runs fails the launch before spawning', async () => {
    const port = await freePort();
    const devServer = nodeApp(port);
    await devServer.start();
    try {
      const failure = await nodeApp(port)
        .start()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect((failure as InfrastructureError).code).toBe('APP_ALREADY_RUNNING');
      expect((failure as InfrastructureError).message).toContain(`http://127.0.0.1:${port}/ already answered before app.command started`);
      expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    } finally {
      await devServer.stop();
    }
  });

  it('with reuseExisting, attaches to a server another process already runs and never stops it', async () => {
    const port = await freePort();
    const devServer = nodeApp(port);
    await devServer.start();
    try {
      // Without reuse this spawn would lose the port; with it, the command is never started.
      const app = nodeApp(port, { reuseExisting: true });
      await app.start();
      expect(app.spawned).toBe(false);
      await app.stop();
      expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    } finally {
      await devServer.stop();
    }
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });
});
