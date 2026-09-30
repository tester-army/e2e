/** ManagedProcess: the readiness wait honours the run's interrupt, `reuseExisting` attaches. */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { ManagedProcess } from '../../src/run/managed-process.ts';
import type { CommandConfig } from '../../src/types.ts';

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
  const stalled = (script: string, extra: Partial<CommandConfig> = {}): CommandConfig => ({
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
      expect(app.spawned).toBe(false);
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
      expect(app.spawned).toBe(false);
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
      // Well under the 2 s probe cap plus the 300 ms budget the old code would have spent back to back.
      expect(elapsed).toBeLessThan(1_500);
      await app.stop();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
