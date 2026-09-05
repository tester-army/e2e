import { createServer } from 'node:net';
import os from 'node:os';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { AppProcess, ServiceStack } from '../../src/run/app-process.ts';
import { InfrastructureError } from '../../src/internal/errors.ts';

const SERVER_SCRIPT = `
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); });
  server.listen(Number(process.argv[1]), '127.0.0.1');
  // Ignore SIGTERM to prove the runner escalates to SIGKILL.
  if (process.argv[2] === 'ignore-sigterm') process.on('SIGTERM', () => {});
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

function nodeApp(port: number, options: { extraArg?: string; startupTimeout?: number } = {}) {
  return new AppProcess(
    {
      executable: process.execPath,
      args: ['-e', SERVER_SCRIPT, String(port), ...(options.extraArg ? [options.extraArg] : [])],
      startupTimeout: options.startupTimeout ?? 15_000,
      shutdownTimeout: 2_000,
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

describe('AppProcess', () => {
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
    const app = new AppProcess(
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
    const app = new AppProcess(
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
    const app = new AppProcess(
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
});

describe('ServiceStack', () => {
  it('waits for a readyUrl service, then a waitForExit step, and stops the service process group', async () => {
    const port = await freePort();
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', SERVER_SCRIPT, String(port)],
          readyUrl: `http://127.0.0.1:${port}/`,
          startupTimeout: 15_000,
          shutdownTimeout: 2_000,
        },
        {
          // The "migration" only succeeds if the service before it is already serving.
          executable: process.execPath,
          args: [
            '-e',
            `fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));`,
            `http://127.0.0.1:${port}/`,
          ],
          waitForExit: true,
          startupTimeout: 15_000,
        },
      ],
      os.tmpdir(),
    );
    await stack.start();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    expect(await stack.stop()).toEqual([]);
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it('fails with APP_UNREACHABLE naming the service when its readyUrl never answers', async () => {
    const port = await freePort();
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          readyUrl: `http://127.0.0.1:${port}/`,
          startupTimeout: 1_500,
          shutdownTimeout: 2_000,
        },
      ],
      os.tmpdir(),
    );
    const failure = await stack.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('app.services[0]');
    expect((failure as InfrastructureError).message).toContain('was not reachable');
    expect(await stack.stop()).toEqual([]);
  }, 20_000);
});
