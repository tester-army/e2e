/** ManagedProcess: the readiness wait honours the run's interrupt, `reuseExisting` attaches. */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfrastructureError } from 'e2e-core/lib/internal/errors';
import { ManagedProcess, stopsSettled } from 'e2e-core/lib/run/managed-process';
import type { CommandConfig } from 'e2e-core/lib/types';
import { freePort } from '../helpers/free-port.ts';

describe('ManagedProcess', () => {
  it('does not report planned shutdown or a successful one-shot command as an unexpected exit', async () => {
    const unexpectedExit = vi.fn();
    const port = await freePort();
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', `require('node:http').createServer((_request, response) => response.end('ready')).listen(${port}, '127.0.0.1');`],
      shutdownTimeout: 1_000,
    }, process.cwd(), { readyUrl: `http://127.0.0.1:${port}/` }, { unexpectedExit });
    try {
      await app.stop();
      await app.start();
    } finally {
      await app.stop();
    }
    const oneShot = new ManagedProcess('setup', {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }, process.cwd(), { waitForExit: true }, { unexpectedExit });
    try {
      await oneShot.start();
    } finally {
      await oneShot.stop();
    }
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  it.each(['preflight', 'startup'] as const)('cancels an in-flight %s readiness probe', async (phase) => {
    let probing!: () => void;
    const probeStarted = new Promise<void>((resolve) => { probing = resolve; });
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      if (phase === 'startup' && requests === 1) response.writeHead(503).end();
      else probing(); // Keep the actual HTTP response pending until cancellation.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const app = new ManagedProcess('app.command', {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      startupTimeout: 10_000,
      shutdownTimeout: 1_000,
    }, process.cwd(), { readyUrl: `http://127.0.0.1:${address.port}/` });
    const controller = new AbortController();
    const pending = app.start(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probeStarted,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`no ${phase} probe was issued`)), 2_000); }),
      ]);
      clearTimeout(timer);
      controller.abort();
      const completed = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
      ]);
      expect(completed).toBe(true);
      expect(app.spawned).toBe(phase === 'startup');
    } finally {
      clearTimeout(timer);
      controller.abort();
      server.closeAllConnections();
      await pending;
      await app.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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

  // Windows has no SIGTERM a process can ignore: the stop ends it at once.
  it.skipIf(process.platform === 'win32')('keeps stopsSettled pending until a stop force-kills a process that ignores SIGTERM at shutdownTimeout', async () => {
    const port = await freePort();
    const app = new ManagedProcess(
      'app.command',
      {
        executable: process.execPath,
        args: ['-e', `process.on('SIGTERM', () => {}); require('node:http').createServer((request, response) => response.end()).listen(${port}, '127.0.0.1');`],
        startupTimeout: 10_000,
        shutdownTimeout: 500,
      },
      process.cwd(),
      { readyUrl: `http://127.0.0.1:${port}/` },
    );
    await app.start(new AbortController().signal);
    const stopped = app.stop();
    let settled = false;
    const settling = stopsSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    await stopped;
    await settling;
    expect(settled).toBe(true);
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

/** Resolves once the file at `file` holds `text`, polling on real I/O turns so it works while the clock is faked. */
async function logged(file: string, text: string): Promise<void> {
  while (!(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(text))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  /** A budget of one second on a fake clock: the test lets the child print, then moves the clock past it. */
  const stalled = (script: string, extra: Partial<CommandConfig> = {}): CommandConfig => ({
    executable: process.execPath,
    args: ['-e', script],
    startupTimeout: 1_000,
    shutdownTimeout: 1_000,
    ...extra,
  });
  /**
   * Starts `app` on a fake clock, waits on real I/O until the log holds
   * `printed`, then spends the whole budget at once. The kill and the exit
   * stay real events.
   */
  const failureOf = async (app: ManagedProcess, printed?: string): Promise<InfrastructureError> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = app.start().catch((error: unknown) => error);
    if (printed !== undefined) await logged(path.join(dir, log), printed);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    const failure = await pending;
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
    const failure = await failureOf(app, 'listening soon');
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
    const failure = (await app.start().catch((error: unknown) => error)) as InfrastructureError;
    expect(failure.code).toBe('APP_UNREACHABLE');
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
    const failure = await failureOf(app, 'redis');
    expect(failure.message).toBe(
      `service "compose" did not exit within 1000 ms\noutput in ${log} since service "compose" started:\n   Image postgres:16.4-alpine Pulling\n   Image redis:7-alpine Pulling`,
    );
    expect(notices).toEqual([]);
  });

  it('quotes every line the command appended when the log since it started fits both windows', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, 'line 25');
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toEqual(lines.map((line) => `  ${line}`));
  });

  it('quotes the first and last 20 lines, and only those, of a log longer than both windows', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} ${'x'.repeat(40)}`);
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, lines[lines.length - 1]!);
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toHaveLength(41);
    expect(quoted.slice(0, 20)).toEqual(lines.slice(0, 20).map((line) => `  ${line}`));
    expect(quoted[20]).toBe('  [startup output omitted]');
    expect(quoted.slice(21)).toEqual(lines.slice(-20).map((line) => `  ${line}`));
  });

  it('quotes whole lines only when the windows cut inside a line at either edge', async () => {
    // Long lines come back as one long command line, so the child builds them.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} ${'y'.repeat(280)}`);
    const script = [
      `const pad = 'y'.repeat(280)`,
      `for (let i = 1; i <= 60; i++) process.stdout.write('line ' + String(i).padStart(2, '0') + ' ' + pad + '\\n')`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, lines[lines.length - 1]!);
    const quoted = failure.message.split('\n').slice(2);
    const printed = quoted.filter((line) => line !== '  [startup output omitted]').map((line) => line.slice(2));
    for (const line of printed) expect(lines).toContain(line);
    expect(quoted).toContain('  [startup output omitted]');
    expect(printed[0]).toBe(lines[0]);
    expect(printed[printed.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('keeps the complete line before a whitespace fragment the head window cut into', async () => {
    // The head window ends 9 bytes into this line's indent, so the fragment it
    // cut is whitespace alone: filtering empty lines first would drop it, and
    // the pop that removes the fragment would then take the fatal line above it.
    const fatal = `fatal: ${'x'.repeat(4_080)}`;
    const lines = [
      fatal,
      '            at Object.<anonymous> (/app/server.js:12:3)',
      ...Array.from({ length: 200 }, (_, i) => `watcher: rebuilt module ${i + 1}`),
    ];
    const script = [
      `process.stdout.write('fatal: ' + 'x'.repeat(4080) + '\\n')`,
      `process.stdout.write('            at Object.<anonymous> (/app/server.js:12:3)\\n')`,
      `for (let i = 1; i <= 200; i++) process.stdout.write('watcher: rebuilt module ' + i + '\\n')`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, lines[lines.length - 1]!);
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted[0]).toBe(`  ${fatal}`);
  });

  it('leaves an earlier run out when the tail window reaches back into it', async () => {
    fs.mkdirSync(path.join(dir, 'out'));
    const earlier = Array.from({ length: 200 }, (_, i) => `earlier run: line ${i + 1}`);
    fs.writeFileSync(path.join(dir, log), `${earlier.join('\n')}\n`);
    const lines = Array.from({ length: 40 }, (_, i) => `added ${i + 1}`);
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, 'added 40');
    expect(failure.message.split('\n').slice(2)).toEqual(lines.map((line) => `  ${line}`));
  });

  it('quotes the first and last 20 lines of a log that fits the byte window but not the line budget', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, 'line 50');
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toHaveLength(41);
    expect(quoted.slice(0, 20)).toEqual(lines.slice(0, 20).map((line) => `  ${line}`));
    expect(quoted[20]).toBe('  [startup output omitted]');
    expect(quoted.slice(21)).toEqual(lines.slice(-20).map((line) => `  ${line}`));
  });

  it('keeps whole lines at both window edges when the cut lands exactly between two lines', async () => {
    // 256-byte lines put the 4 KiB window edge on a line boundary at both ends.
    const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} ${'z'.repeat(247)}`);
    const script = [
      `const pad = 'z'.repeat(247)`,
      `for (let i = 1; i <= 60; i++) process.stdout.write('line ' + String(i).padStart(2, '0') + ' ' + pad + '\\n')`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, lines[lines.length - 1]!);
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toHaveLength(33);
    expect(quoted.slice(0, 16)).toEqual(lines.slice(0, 16).map((line) => `  ${line}`));
    expect(quoted[16]).toBe('  [startup output omitted]');
    expect(quoted.slice(17)).toEqual(lines.slice(-16).map((line) => `  ${line}`));
  });

  it('keeps the marker when the head window sits inside one huge first line', async () => {
    const script = [
      `process.stdout.write('fatal: ' + 'x'.repeat(5000) + '\\n')`,
      `for (let i = 1; i <= 400; i++) process.stdout.write('watcher: rebuilt module ' + i + '\\n')`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, 'watcher: rebuilt module 400');
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toHaveLength(21);
    expect(quoted[0]).toBe('  [startup output omitted]');
    expect(quoted[20]).toBe('  watcher: rebuilt module 400');
  });

  it('quotes a log of 25 long lines whole while it stays inside the byte window', async () => {
    const body = (index: number) => `line ${String(index + 1).padStart(2, '0')} ${'w'.repeat(241)}`;
    const lines = Array.from({ length: 25 }, (_, i) => body(i));
    const script = [
      `const pad = 'w'.repeat(241)`,
      `for (let i = 1; i <= 25; i++) process.stdout.write('line ' + String(i).padStart(2, '0') + ' ' + pad + '\\n')`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, lines[lines.length - 1]!);
    expect(failure.message.split('\n').slice(2)).toEqual(lines.map((line) => `  ${line}`));
  });

  it('quotes whole lines around the marker when a short log has lines longer than the byte window', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => {
      const prefix = `line ${i + 1} `;
      return prefix + 'v'.repeat(1_024 - prefix.length);
    });
    const script = [
      `for (let i = 1; i <= 10; i++) { const prefix = 'line ' + i + ' '; process.stdout.write(prefix + 'v'.repeat(1024 - prefix.length) + '\\n') }`,
      'setInterval(() => {}, 1000)',
    ].join('; ');
    const app = new ManagedProcess('service "compose"', stalled(script, { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, `${lines[lines.length - 1]!.slice(0, 24)}`);
    const quoted = failure.message.split('\n').slice(2);
    expect(quoted).toHaveLength(7);
    expect(quoted.slice(0, 3)).toEqual(lines.slice(0, 3).map((line) => `  ${line}`));
    expect(quoted[3]).toBe('  [startup output omitted]');
    expect(quoted.slice(4)).toEqual(lines.slice(-3).map((line) => `  ${line}`));
  });

  it('keeps the first line the command wrote when the log it appends to did not end with one', async () => {
    fs.mkdirSync(path.join(dir, 'out'));
    fs.writeFileSync(path.join(dir, log), 'from an earlier run that never finished its line');
    const lines = ['fatal: EADDRINUSE', ...Array.from({ length: 400 }, (_, i) => `watcher: rebuilt module ${i + 1}`)];
    const app = new ManagedProcess('service "compose"', stalled(printThen(lines), { log }), dir, { waitForExit: true });
    const failure = await failureOf(app, 'watcher: rebuilt module 400');
    expect(failure.message.split('\n').slice(2)[0]).toBe('  fatal: EADDRINUSE');
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
    const failure = await failureOf(app, 'token=');
    expect(failure.message).toBe(
      `service "compose" did not exit within 1000 ms\noutput in ${log} since service "compose" started:\n  token=<secret:SECRET> port=443`,
    );
    expect(fs.readFileSync(path.join(dir, log), 'utf8')).toContain('token=hunter2-hunter2');
  });

  it('redacts inheritEnv values from the quoted output too', async () => {
    vi.stubEnv('E2E_TEST_INHERITED_TOKEN', 'inherited-token-value');
    try {
      const app = new ManagedProcess(
        'service "compose"',
        stalled(`process.stdout.write('token=' + process.env.E2E_TEST_INHERITED_TOKEN + '\\n'); setInterval(() => {}, 1000);`, {
          log,
          inheritEnv: ['E2E_TEST_INHERITED_*'],
        }),
        dir,
        { waitForExit: true },
      );
      const failure = await failureOf(app, 'token=');
      expect(failure.message).toContain('  token=<secret:E2E_TEST_INHERITED_TOKEN>');
    } finally {
      vi.unstubAllEnvs();
    }
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

  /** A command that stays up like a server would. */
  const serverApp = (reuseExisting: boolean) => ({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    startupTimeout: 10_000,
    shutdownTimeout: 2_000,
    reuseExisting,
  });

  it('attaches to an app already answering at readyUrl: nothing spawns and stop leaves it running', async () => {
    const running = await alreadyRunning();
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        serverApp(true),
        dir,
        { readyUrl: running.url },
        { ci: false, notice: (message) => notices.push(message) },
      );
      await app.start();
      expect(app.spawned).toBe(false);
      expect(notices).toEqual([`app.command: reusing the process already serving ${running.url}`]);
      await app.stop();
      expect(await isReachable(running.url)).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('ignores reuseExisting in CI: an already-answering URL is APP_ALREADY_RUNNING, nothing spawns', async () => {
    const running = await alreadyRunning();
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        serverApp(true),
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
    } finally {
      await running.close();
    }
  });

  it('without reuseExisting, an already-answering URL is APP_ALREADY_RUNNING instead of passing as the new command', async () => {
    const running = await alreadyRunning();
    const notices: string[] = [];
    try {
      const app = new ManagedProcess(
        'app.command',
        serverApp(false),
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
      expect(app.spawned).toBe(false);
      expect(notices).toEqual([]);
      await app.stop();
      expect(await isReachable(running.url)).toBe(true);
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
    try {
      const app = new ManagedProcess(
        'app.command',
        { ...serverApp(true), startupTimeout: 300 },
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

describe('ManagedProcess env', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-process-env-'));
    vi.stubEnv('E2E_TEST_DATABASE_URL', 'postgres://from-host');
    vi.stubEnv('E2E_TEST_STRIPE_KEY', 'sk_host');
    vi.stubEnv('E2E_TEST_STRIPE_HOOK', 'wh_host');
    vi.stubEnv('E2E_TEST_MODEL_KEY', 'model-key');
    vi.stubEnv('E2E_TEST_DATABASE_URL_RO', 'postgres://replica');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs a command that writes its own environment to `env.json` in the project root, and reads it back. */
  const envOf = async (extra: Partial<CommandConfig>, runEnv?: NodeJS.ProcessEnv): Promise<Record<string, string>> => {
    await new ManagedProcess(
      'app.command',
      { executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync('env.json', JSON.stringify(process.env))`], cwd: dir, ...extra },
      dir,
      { waitForExit: true },
      runEnv === undefined ? {} : { env: runEnv },
    ).start();
    return JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')) as Record<string, string>;
  };

  it('passes only the default set without inheritEnv', async () => {
    const env = await envOf({});
    expect(Object.keys(env).filter((key) => key.startsWith('E2E_TEST_'))).toEqual([]);
  });

  it('copies listed variables, leaves the rest out, and lets command.env win', async () => {
    const env = await envOf({
      inheritEnv: ['E2E_TEST_DATABASE_URL', 'E2E_TEST_STRIPE_*'],
      env: { E2E_TEST_STRIPE_HOOK: 'wh_config' },
    });
    expect(env).toMatchObject({
      E2E_TEST_DATABASE_URL: 'postgres://from-host',
      E2E_TEST_STRIPE_KEY: 'sk_host',
      E2E_TEST_STRIPE_HOOK: 'wh_config',
    });
    expect(env).not.toHaveProperty('E2E_TEST_MODEL_KEY');
    expect(env).not.toHaveProperty('E2E_TEST_DATABASE_URL_RO');
  });

  it('copies from the environment the run resolves against, not process.env, when one is passed', async () => {
    const env = await envOf({ inheritEnv: ['E2E_TEST_DATABASE_URL', 'E2E_TEST_STRIPE_*'] }, { E2E_TEST_DATABASE_URL: 'postgres://per-task' });
    expect(env).toMatchObject({ E2E_TEST_DATABASE_URL: 'postgres://per-task' });
    expect(env).not.toHaveProperty('E2E_TEST_STRIPE_KEY');
  });

  it('matches and replaces names case-insensitively on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const env = await envOf(
        { inheritEnv: ['E2E_TEST_DATABASE_URL', 'E2E_TEST_STRIPE_*'], env: { e2e_test_stripe_key: 'sk_config' } },
        { E2e_Test_Database_Url: 'postgres://host', E2E_Test_Stripe_Key: 'sk_host' },
      );
      expect(Object.entries(env).filter(([key]) => key.toUpperCase().startsWith('E2E_TEST_'))).toEqual([
        ['E2e_Test_Database_Url', 'postgres://host'],
        ['e2e_test_stripe_key', 'sk_config'],
      ]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
