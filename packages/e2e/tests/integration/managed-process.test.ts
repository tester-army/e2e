import os from 'node:os';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { ManagedProcess } from '../../src/run/managed-process.ts';
import { defineService } from '../../src/services.ts';
import type { ServiceHandle } from '../../src/types.ts';
import { freePort } from '../helpers/free-port.ts';
import { serviceStack } from '../helpers/service-stack.ts';

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

/** The services a run would start for one target listing `services`. */
function stackOf(services: readonly ServiceHandle[], cleanupTimeout = 5_000) {
  return serviceStack(services, { projectRoot: os.tmpdir(), cleanupTimeout });
}

describe('target services', () => {
  it('waits for a readyUrl service, then a waitForExit step, and stops the service process group', async () => {
    const port = await freePort();
    const server = defineService({
      name: 'server',
      executable: process.execPath,
      args: ['-e', SERVER_SCRIPT, String(port)],
      readyUrl: `http://127.0.0.1:${port}/`,
      startupTimeout: 15_000,
      shutdownTimeout: 2_000,
    });
    const migrate = defineService({
      name: 'migrate',
      // The "migration" only succeeds if the service it depends on is already serving.
      executable: process.execPath,
      args: ['-e', `fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));`, `http://127.0.0.1:${port}/`],
      waitForExit: true,
      startupTimeout: 15_000,
      dependsOn: [server],
    });
    const stack = stackOf([migrate]);
    await stack.start();
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(true);
    expect(await stack.stop()).toEqual([]);
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it('fails with APP_UNREACHABLE naming the service when its readyUrl never answers', async () => {
    const port = await freePort();
    const stack = stackOf([
      defineService({
        name: 'auth-emulator',
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        readyUrl: `http://127.0.0.1:${port}/`,
        startupTimeout: 1_500,
        shutdownTimeout: 2_000,
      }),
    ]);
    const failure = await stack.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toBe(
      `service "auth-emulator" was not reachable at http://127.0.0.1:${port}/ within 1500 ms\nset log on this command to keep its output`,
    );
    expect(await stack.stop()).toEqual([]);
  }, 20_000);

  it('hands the whole runner environment to a service, with its own env on top', async () => {
    const previous = process.env['E2E_INHERITED_PROBE'];
    process.env['E2E_INHERITED_PROBE'] = 'from-the-runner';
    try {
      const probe = defineService({
        name: 'probe',
        executable: process.execPath,
        args: ['-e', "process.exit(process.env.E2E_INHERITED_PROBE === 'from-the-runner' && process.env.OWN === 'set' ? 0 : 1)"],
        env: { OWN: 'set' },
        waitForExit: true,
        startupTimeout: 15_000,
      });
      const stack = stackOf([probe]);
      await stack.start();
      expect(await stack.stop()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['E2E_INHERITED_PROBE'];
      else process.env['E2E_INHERITED_PROBE'] = previous;
    }
  }, 20_000);

  it('runs a function service in dependency order with its dependencies addresses, and stops everything in reverse', async () => {
    const port = await freePort();
    const events: string[] = [];
    const api = defineService({
      name: 'api',
      executable: process.execPath,
      args: ['-e', SERVER_SCRIPT, String(port)],
      readyUrl: `http://127.0.0.1:${port}/`,
      startupTimeout: 15_000,
      shutdownTimeout: 2_000,
      teardown: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    });
    const seed = defineService({
      name: 'seed',
      dependsOn: [api],
      async start(context) {
        events.push(`seed.start ${context.services['api']?.url} ${String(await isReachable(`http://127.0.0.1:${port}/`))}`);
      },
      async stop(context) {
        events.push(`seed.stop ${String(context.signal.aborted)} ${String(await isReachable(`http://127.0.0.1:${port}/`))}`);
      },
    });
    const stack = stackOf([seed]);
    await stack.start();
    expect(events).toEqual([`seed.start http://127.0.0.1:${port} true`]);
    expect(await stack.stop()).toEqual([]);
    // The seed stops while the api it depends on still serves, and the api after it.
    expect(events).toEqual([`seed.start http://127.0.0.1:${port} true`, 'seed.stop false true']);
    expect(await isReachable(`http://127.0.0.1:${port}/`)).toBe(false);
  }, 20_000);

  it('fails the start with APP_UNREACHABLE when a function service throws, and bounds its stop by the cleanup budget', async () => {
    const broken = stackOf([defineService({ name: 'seed', start: async () => { throw new Error('no database'); } })]);
    await expect(broken.start()).rejects.toMatchObject({ code: 'APP_UNREACHABLE', message: 'service "seed" failed to start: no database' });
    const stuck = stackOf([defineService({ name: 'stuck', start: async () => {}, stop: () => new Promise(() => {}) })], 200);
    await stuck.start();
    expect(await stuck.stop()).toEqual([expect.objectContaining({ code: 'CLEANUP_TIMEOUT', message: 'service "stuck" stop failed: timed out after 200 ms' })]);
  });
});
