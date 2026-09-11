/** ManagedProcess: the readiness wait honours the run's interrupt, `reuseExisting` attaches. ServiceStack: order and teardown. */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServices } from '../../src/config/app.ts';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { ManagedProcess, ServiceStack } from '../../src/run/managed-process.ts';
import type { ServiceConfig } from '../../src/types.ts';

describe('ManagedProcess', () => {
  it('stops waiting for readiness and takes the process down when the signal aborts', async () => {
    const app = new ManagedProcess(
      'app.command',
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        startupTimeout: 10_000,
        shutdownTimeout: 2_000,
      },
      process.cwd(),
      { readyUrl: 'http://127.0.0.1:1/' },
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const startedAt = Date.now();
    await app.start(controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await app.stop();
  }, 20_000);
});

/** Prints one line to stdout and one to stderr, then exits with `exitCode`. */
function chatter(exitCode = 0): string {
  return `console.log('to stdout'); console.error('to stderr'); process.exit(${exitCode});`;
}

describe('ManagedProcess log', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-process-log-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const step = (log: string) =>
    new ManagedProcess(
      'app.command',
      { executable: process.execPath, args: ['-e', chatter()], log },
      dir,
      { waitForExit: true },
    );

  it('captures stdout and stderr into the log file, resolved from the project root', async () => {
    await step('out/app.log').start();
    const content = fs.readFileSync(path.join(dir, 'out', 'app.log'), 'utf8');
    expect(content).toContain('to stdout\n');
    expect(content).toContain('to stderr\n');
  });

  it('appends across runs instead of truncating', async () => {
    await step('app.log').start();
    await step('app.log').start();
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
    expect(lines.filter((line) => line === 'to stdout')).toHaveLength(2);
    expect(lines.filter((line) => line === 'to stderr')).toHaveLength(2);
  });

  it('creates missing parent directories', async () => {
    await step(path.join('.e2e', 'logs', 'nested', 'app.log')).start();
    expect(fs.existsSync(path.join(dir, '.e2e', 'logs', 'nested', 'app.log'))).toBe(true);
  });

  it('fails with APP_UNREACHABLE when the log path cannot be opened', async () => {
    fs.mkdirSync(path.join(dir, 'app.log'));
    const failure = await step('app.log')
      .start()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('could not open its log file');
  });

  it('discards output when log is unset', async () => {
    await new ManagedProcess(
      'app.command',
      { executable: process.execPath, args: ['-e', chatter()] },
      dir,
      { waitForExit: true },
    ).start();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

/** Writes each line to stdout, then stays up like a server that never comes ready (or exits, when told). */
function printThen(lines: readonly string[], exitCode?: number): string {
  const print = `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + '\\n');`;
  return exitCode === undefined ? `${print} setInterval(() => {}, 1000);` : `${print} process.exit(${exitCode});`;
}

describe('ManagedProcess stall diagnostics', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-stall-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const log = path.join('out', 'services.log');
  /** A budget of one second: the child prints within a few dozen ms and then the wait has to run out. */
  const stalled = (script: string, extra: Partial<ServiceConfig> = {}) => ({
    executable: process.execPath,
    args: ['-e', script],
    startupTimeout: 1_000,
    shutdownTimeout: 1_000,
    ...extra,
  });
  const failureOf = async (app: ManagedProcess): Promise<InfrastructureError> => {
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    return failure as InfrastructureError;
  };

  it('ends a readiness timeout with the lines the process appended, controls stripped, earlier runs left out', async () => {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, log), 'from an earlier run\n');
    const app = new ManagedProcess(
      'target "web" command',
      stalled(printThen(['booting', '\u001b[32mlistening soon\u001b[0m', '']), { log }),
      dir,
      { readyUrl: 'http://127.0.0.1:1/' },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(
      `target "web" command was not reachable at http://127.0.0.1:1/ within 1000 ms\noutput in ${log} since target "web" command started:\n  booting\n  listening soon`,
    );
    await app.stop();
  });

  it('ends an early exit with the same tail', async () => {
    const app = new ManagedProcess(
      'target "web" command',
      stalled(printThen(['migrations pending', 'fatal: database "app" does not exist'], 1), { log }),
      dir,
      { readyUrl: 'http://127.0.0.1:1/' },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(
      `target "web" command exited with code 1 before becoming ready\noutput in ${log} since target "web" command started:\n  migrations pending\n  fatal: database "app" does not exist`,
    );
  });

  it('ends a waitForExit timeout with the tail, and a budget under 10 s never narrates progress', async () => {
    const notices: string[] = [];
    const app = new ManagedProcess(
      'service "compose"',
      stalled(printThen([' Image postgres:16.4-alpine Pulling ', ' Image redis:7-alpine Pulling ']), { log }),
      dir,
      { waitForExit: true },
      { notice: (message) => notices.push(message) },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(
      `service "compose" did not exit within 1000 ms\noutput in ${log} since service "compose" started:\n   Image postgres:16.4-alpine Pulling\n   Image redis:7-alpine Pulling`,
    );
    expect(notices).toEqual([]);
  });

  it('keeps the last 20 lines only', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app);
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toEqual(lines.slice(5).map((line) => `  ${line}`));
  });

  it('redacts command.env values from the quoted output with the report-wide secret markers, the log itself untouched', async () => {
    const app = new ManagedProcess(
      'service "compose"',
      stalled(
        `process.stdout.write('token=' + process.env.SECRET + ' port=' + process.env.PORT + '\\n'); setInterval(() => {}, 1000);`,
        { log, env: { SECRET: 'hunter2-hunter2', PORT: '443' } },
      ),
      dir,
      { waitForExit: true },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(
      `service "compose" did not exit within 1000 ms\noutput in ${log} since service "compose" started:\n  token=<secret:SECRET> port=443`,
    );
    expect(fs.readFileSync(path.join(dir, log), 'utf8')).toContain('token=hunter2-hunter2');
  });

  it('says so when the process wrote nothing', async () => {
    const app = new ManagedProcess(
      'service "compose"',
      stalled('setInterval(() => {}, 1000)', { log }),
      dir,
      { waitForExit: true },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(`service "compose" did not exit within 1000 ms\nno output in ${log}`);
  });

  it('points at log when the command has none', async () => {
    const app = new ManagedProcess(
      'service "compose"',
      stalled(printThen(['lost without a log'])),
      dir,
      { waitForExit: true },
    );
    const failure = await failureOf(app);
    expect(failure.message).toBe(
      'service "compose" did not exit within 1000 ms\nset log on this command to keep its output',
    );
    expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
  });

  it('narrates once at half the budget while the wait goes on', async () => {
    // The wait is clocked, not the child: fake time moves the poll loop past
    // the half-way mark in an instant, the process itself stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const notices: string[] = [];
    const app = new ManagedProcess(
      'service "compose"',
      stalled('setInterval(() => {}, 1000)', { startupTimeout: 10_000, log }),
      dir,
      { waitForExit: true },
      { notice: (message) => notices.push(message) },
    );
    const pending = app.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(notices).toEqual([]);
    // The poll wakes at the half mark itself, not at the next 250 ms tick.
    await vi.advanceTimersByTimeAsync(100);
    expect(notices).toEqual([`service "compose" still starting after 5s: waiting for it to exit; log: ${log}`]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toHaveLength(1);
    // The deadline has passed on the fake clock; the kill and the exit are real events.
    vi.useRealTimers();
    const failure = await pending;
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect((failure as InfrastructureError).message).toContain('did not exit within 10000 ms');
  });

  it('names the URL it waits for on a readyUrl command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const notices: string[] = [];
    const app = new ManagedProcess(
      'target "web" command',
      stalled('setInterval(() => {}, 1000)', { startupTimeout: 10_000 }),
      dir,
      { readyUrl: 'http://127.0.0.1:1/' },
      { notice: (message) => notices.push(message) },
    );
    const pending = app.start().catch((error: unknown) => error);
    // The preflight probe is a real connection attempt; give it a turn before moving the clock.
    await new Promise((resolve) => process.nextTick(resolve));
    await vi.advanceTimersByTimeAsync(5_300);
    expect(notices).toEqual(['target "web" command still starting after 5s: waiting for http://127.0.0.1:1/']);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    const failure = await pending;
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
  });
});

/** A service that appends its tag to a shared log and exits 0; the log is the order of events. */
function logStep(log: string, tag: string, exitCode = 0): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tag)} + '\\n'); process.exit(${exitCode});`;
}

function readLog(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** An in-process server standing in for the dev server the user already has running. */
async function alreadyRunning(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

describe('ManagedProcess reuseExisting', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reuse-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A command that proves it ran by writing a marker, then stays up like a server would. */
  const markerApp = (marker: string, reuseExisting: boolean) => ({
    executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`],
    startupTimeout: 10_000,
    shutdownTimeout: 2_000,
    reuseExisting,
  });

  it('attaches to an app already answering at readyUrl: nothing spawns and stop leaves it running', async () => {
    const running = await alreadyRunning();
    const marker = path.join(dir, 'started');
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        markerApp(marker, true),
        dir,
        { readyUrl: running.url },
        { ci: false, notice: (message) => notices.push(message) },
      );
      await app.start();
      expect(app.reused).toBe(true);
      expect(notices).toEqual([`app.command: reusing the process already serving ${running.url}`]);
      await app.stop();
      expect(await isReachable(running.url)).toBe(true);
      // Had the command spawned, its marker would appear within a moment; give it that moment.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('ignores reuseExisting in CI: an already-answering URL is APP_ALREADY_RUNNING, nothing spawns', async () => {
    const running = await alreadyRunning();
    const marker = path.join(dir, 'started');
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        markerApp(marker, true),
        dir,
        { readyUrl: running.url },
        { ci: true, notice: (message) => notices.push(message) },
      );
      const failure = await app.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect((failure as InfrastructureError).code).toBe('APP_ALREADY_RUNNING');
      expect((failure as InfrastructureError).message).toBe(
        `${running.url} already answered before app.command started; stop that process (reuseExisting is ignored in CI)`,
      );
      expect(app.reused).toBe(false);
      expect(notices).toEqual(['app.command: reuseExisting is ignored in CI, starting the command']);
      await app.stop();
      expect(await isReachable(running.url)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('without reuseExisting, an already-answering URL is APP_ALREADY_RUNNING instead of passing as the new command', async () => {
    const running = await alreadyRunning();
    const marker = path.join(dir, 'started');
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        markerApp(marker, false),
        dir,
        { readyUrl: running.url },
        { ci: false, notice: (message) => notices.push(message) },
      );
      const failure = await app.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect((failure as InfrastructureError).code).toBe('APP_ALREADY_RUNNING');
      expect((failure as InfrastructureError).message).toBe(
        `${running.url} already answered before app.command started; stop that process or set reuseExisting: true`,
      );
      expect(notices).toEqual([]);
      await app.stop();
      expect(await isReachable(running.url)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('spends the preflight probe from startupTimeout: a slow answer past the budget is APP_UNREACHABLE on time', async () => {
    // A server that takes longer than the whole budget to answer: the probe must give up within it.
    const server = http.createServer((_request, response) => {
      setTimeout(() => {
        response.statusCode = 200;
        response.end('late');
      }, 5_000);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const marker = path.join(dir, 'started');
    try {
      const app = new ManagedProcess(
        'app.command',
        { ...markerApp(marker, true), startupTimeout: 300 },
        dir,
        { readyUrl: `http://127.0.0.1:${address.port}/` },
        { ci: false },
      );
      const startedAt = Date.now();
      const failure = await app.start().catch((error: unknown) => error);
      const elapsed = Date.now() - startedAt;
      expect(failure).toBeInstanceOf(InfrastructureError);
      expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
      expect((failure as InfrastructureError).message).toContain('within 300 ms');
      expect(app.reused).toBe(false);
      // Well under the 2 s probe cap plus the 300 ms budget the old code would have spent back to back.
      expect(elapsed).toBeLessThan(1_500);
      await app.stop();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('reuses a readyUrl service the same way and skips its teardown', async () => {
    const running = await alreadyRunning();
    const log = path.join(dir, 'log');
    const notices: string[] = [];
    try {
      const stack = new ServiceStack(
        resolveServices([
          {
            name: 'emulator',
            executable: process.execPath,
            args: ['-e', logStep(log, 'up:emulator')],
            readyUrl: running.url,
            reuseExisting: true,
            teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:emulator')] },
          },
          { executable: process.execPath, args: ['-e', logStep(log, 'up:migrate')], waitForExit: true },
        ], dir),
        dir,
        { ci: false, notice: (message) => notices.push(message) },
      );
      await stack.start();
      expect(notices).toEqual([`service "emulator": reusing the process already serving ${running.url}`]);
      const failures: unknown[] = [];
      await stack.stop((cause) => failures.push(cause));
      expect(failures).toEqual([]);
      expect(readLog(log)).toEqual(['up:migrate']);
      expect(await isReachable(running.url)).toBe(true);
    } finally {
      await running.close();
    }
  });
});

/** Stops the stack and collects what its teardowns reported. */
async function stopAll(stack: ServiceStack): Promise<unknown[]> {
  const failures: unknown[] = [];
  await stack.stop((cause) => failures.push(cause));
  return failures;
}

describe('ServiceStack', () => {
  let dir: string;
  const stack = (services: readonly ServiceConfig[]) =>
    new ServiceStack(resolveServices(services, dir), dir);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-services-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports each service starting and ready through the hooks, in order', async () => {
    const events: string[] = [];
    const services = new ServiceStack(
      resolveServices(
        [
          { name: 'db', executable: process.execPath, args: ['-e', 'process.exit(0)'], waitForExit: true },
          { name: 'seed', executable: process.execPath, args: ['-e', 'process.exit(0)'], waitForExit: true },
        ],
        dir,
      ),
      dir,
      {
        starting: (label) => events.push(`starting ${label}`),
        ready: (label, durationMs, reused) => events.push(`ready ${label} ${durationMs >= 0} ${reused}`),
      },
    );
    await services.start();
    expect(events).toEqual([
      'starting service "db"',
      'ready service "db" true false',
      'starting service "seed"',
      'ready service "seed" true false',
    ]);
    expect(await stopAll(services)).toEqual([]);
  });

  it('starts waitForExit services in order and runs their teardowns in reverse', async () => {
    const log = path.join(dir, 'log');
    const services = stack([
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
    ]);
    await services.start();
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'up:seed']);
    expect(await stopAll(services)).toEqual([]);
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'up:seed', 'down:seed', 'down:db']);
    // A second stop has nothing left to do.
    expect(await stopAll(services)).toEqual([]);
    expect(readLog(log)).toHaveLength(5);
  });

  it('writes service and teardown output to their log files, sharing one file when told to', async () => {
    const services = stack([
      {
        executable: process.execPath,
        args: ['-e', chatter()],
        waitForExit: true,
        log: 'services.log',
        teardown: { executable: process.execPath, args: ['-e', chatter()], log: 'services.log' },
      },
      {
        executable: process.execPath,
        args: ['-e', chatter(3)],
        waitForExit: true,
        log: path.join('.e2e', 'migrate.log'),
      },
    ]);
    const failure = await services.start().catch((error: unknown) => error);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    expect(await stopAll(services)).toEqual([]);
    const shared = fs.readFileSync(path.join(dir, 'services.log'), 'utf8');
    expect(shared.match(/to stdout/g)).toHaveLength(2);
    expect(shared.match(/to stderr/g)).toHaveLength(2);
    const migrate = fs.readFileSync(path.join(dir, '.e2e', 'migrate.log'), 'utf8');
    expect(migrate).toContain('to stdout');
    expect(migrate).toContain('to stderr');
  });

  it('fails with APP_UNREACHABLE naming the service when a waitForExit service exits non-zero, and still tears down', async () => {
    const log = path.join(dir, 'log');
    const services = stack([
      {
        executable: process.execPath,
        args: ['-e', logStep(log, 'up:db')],
        waitForExit: true,
        teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:db')] },
      },
      {
        name: 'migrate',
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
    ]);
    const failure = await services.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    // The name replaces the position and the command line, which here would be a page of script.
    expect((failure as InfrastructureError).message).toBe(
      'service "migrate" exited with code 2 instead of 0\nset log on this command to keep its output',
    );
    // The third service never started; the two that did are torn down in reverse.
    expect(await stopAll(services)).toEqual([]);
    expect(readLog(log)).toEqual(['up:db', 'up:migrate', 'down:migrate', 'down:db']);
  });

  it('reports teardown failures instead of throwing and keeps tearing down', async () => {
    const log = path.join(dir, 'log');
    const services = stack([
      {
        executable: process.execPath,
        args: ['-e', logStep(log, 'up:a')],
        waitForExit: true,
        teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:a')] },
      },
      {
        name: 'cache',
        executable: process.execPath,
        args: ['-e', logStep(log, 'up:b')],
        waitForExit: true,
        teardown: { executable: process.execPath, args: ['-e', logStep(log, 'down:b', 1)] },
      },
    ]);
    await services.start();
    const failures = await stopAll(services);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(InfrastructureError);
    expect((failures[0] as InfrastructureError).message).toBe(
      'service "cache" teardown exited with code 1 instead of 0\nset log on this command to keep its output',
    );
    expect(readLog(log)).toEqual(['up:a', 'up:b', 'down:b', 'down:a']);
  });

  it('times out a waitForExit service that never exits and kills it', async () => {
    const services = stack([
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        waitForExit: true,
        startupTimeout: 500,
        shutdownTimeout: 1_000,
      },
    ]);
    const startedAt = Date.now();
    const failure = await services.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).code).toBe('APP_UNREACHABLE');
    // No name configured: the executable's base name stands in.
    expect((failure as InfrastructureError).message).toBe(
      `service "${path.basename(process.execPath)}" did not exit within 500 ms\nset log on this command to keep its output`,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await stopAll(services)).toEqual([]);
  }, 20_000);

  it('stops starting services once the signal aborts and still tears down what started', async () => {
    const log = path.join(dir, 'log');
    const controller = new AbortController();
    const services = stack([
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
    ]);
    setTimeout(() => controller.abort(), 300);
    await services.start(controller.signal);
    expect(await stopAll(services)).toEqual([]);
    expect(readLog(log)).toEqual(['up:a', 'down:a']);
  }, 20_000);
});
