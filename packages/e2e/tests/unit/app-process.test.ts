/** AppProcess startup: the readiness wait honours the run's interrupt. ServiceStack: order and teardown. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProcess, ServiceStack } from '../../src/run/app-process.ts';
import { InfrastructureError } from '../../src/internal/errors.ts';

describe('AppProcess', () => {
  it('stops waiting for readiness and takes the process down when the signal aborts', async () => {
    // A child that never serves anything, and a ready URL that never answers.
    const app = new AppProcess(
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        startupTimeout: 30_000,
        shutdownTimeout: 2_000,
      },
      process.cwd(),
      { readyUrl: 'http://127.0.0.1:1/' },
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const startedAt = Date.now();
    await app.start(controller.signal);
    // Well inside the startup timeout: the abort, not the deadline, ended the wait.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The child is already gone; a second stop is a no-op rather than a hang.
    await app.stop();
  }, 20_000);
});

/** A service that appends its tag to a shared log and exits 0; the log is the order of events. */
function logStep(log: string, tag: string, exitCode = 0): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tag)} + '\\n'); process.exit(${exitCode});`;
}

function readLog(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe('ServiceStack', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-services-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts waitForExit services in order and runs their teardowns in reverse', async () => {
    const log = path.join(dir, 'log');
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:db')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:db')] },
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:migrate')],
          waitForExit: true,
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:seed')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:seed')] },
        },
      ],
      dir,
    );
    await stack.start();
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'up:seed']);
    expect(await stack.stop()).toEqual([]);
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'up:seed', 'down:seed', 'down:db']);
    // A second stop has nothing left to do.
    expect(await stack.stop()).toEqual([]);
    expect(readLog(log)).toHaveLength(5);
  });

  it('fails with APP_UNREACHABLE naming the service when a waitForExit service exits non-zero, and still tears down', async () => {
    const log = path.join(dir, 'log');
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:db')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:db')] },
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:migrate', 2)],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:migrate')] },
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:never')],
          waitForExit: true,
        },
      ],
      dir,
    );
    const failure = await stack.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('app.services[1]');
    expect((failure as InfrastructureError).message).toContain('exited with code 2 instead of 0');
    // The third service never started; the two that did are torn down in reverse.
    expect(await stack.stop()).toEqual([]);
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'down:migrate', 'down:db']);
  });

  it('returns teardown failures instead of throwing and keeps tearing down', async () => {
    const log = path.join(dir, 'log');
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:a')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:a')] },
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:b')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:b', 1)] },
        },
      ],
      dir,
    );
    await stack.start();
    const failures = await stack.stop();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(InfrastructureError);
    expect((failures[0] as InfrastructureError).message).toContain('app.services[1]');
    expect((failures[0] as InfrastructureError).message).toContain('teardown');
    expect((failures[0] as InfrastructureError).message).toContain('exited with code 1 instead of 0');
    expect(readLog(log)).toEqual(['up:a', 'up:b', 'down:b', 'down:a']);
  });

  it('times out a waitForExit service that never exits and kills it', async () => {
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          waitForExit: true,
          startupTimeout: 500,
          shutdownTimeout: 1_000,
        },
      ],
      dir,
    );
    const startedAt = Date.now();
    const failure = await stack.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('did not exit within 500 ms');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await stack.stop()).toEqual([]);
  }, 20_000);

  it('stops starting services once the signal aborts and still tears down what started', async () => {
    const log = path.join(dir, 'log');
    const controller = new AbortController();
    const stack = new ServiceStack(
      [
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:a')],
          waitForExit: true,
          teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:a')] },
        },
        {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          waitForExit: true,
          shutdownTimeout: 1_000,
        },
        {
          executable: process.execPath,
          args: ['-e', logStep(log, 'up:never')],
          waitForExit: true,
        },
      ],
      dir,
    );
    setTimeout(() => controller.abort(), 300);
    await stack.start(controller.signal);
    expect(await stack.stop()).toEqual([]);
    expect(readLog(log)).toEqual(['up:a', 'down:a']);
  }, 20_000);
});
