/**
 * Ctrl-C against the built CLI, the way a terminal delivers it: SIGINT to the
 * whole process group, runner and workers alike. The engine is a file-logging
 * fake declared in the fixture config, so the test can see, from outside,
 * whether the engine was disposed and whether the worker outlived the runner.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** Cleanup budget of the fixture config; every teardown here is bounded by it. */
const CLEANUP_TIMEOUT_MS = 5_000;

/** Fixture-side logger: one `<pid> <event>` line per call into the file the test reads. */
const LOG_HELPER =
  "const log = (line) => appendFileSync(process.env.SIGNAL_LOG, process.pid + ' ' + line + '\\n');";

/**
 * A fixture config around the file-logging fake engine; `app` is the engine's
 * app declaration source, empty by default.
 */
function config(app = ''): string {
  return `import { appendFileSync } from 'node:fs';
import type { E2EConfig } from '@e2edev/e2e';
import { defineEngine } from '@e2edev/e2e/engine';

${LOG_HELPER}
const node = { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go', states: { hidden: false } };

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'ios', engine: defineEngine({
    name: 'signal-fake',
    version: '1.0.0',
    spiVersion: 1,
    ${app}
    async init() { log('init'); },
    async startAttempt() { log('startAttempt'); },
    async endAttempt() { log('endAttempt'); },
    async dispose() { log('dispose'); },
    async observe() { return { location: 'app://fake/Home', root: node, viewport: { width: 1280, height: 720, scale: 1 } }; },
    async locate() { return [node]; },
  }) }],
  timeout: 60_000,
  cleanupTimeout: ${CLEANUP_TIMEOUT_MS},
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;
}

/**
 * A service that never becomes ready and never dies on its own: it logs its
 * pid, ignores SIGTERM, and spawns a grandchild that does the same, so only a
 * kill of the whole process group can end either. Startup is interrupted
 * while the runner still waits for `readyUrl`, and the graceful stop then
 * hangs on the ignored SIGTERM for the whole `shutdownTimeout`.
 */
const STUCK_SERVICE = `const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
${LOG_HELPER}
process.on('SIGTERM', () => {});
if (process.argv[2] === 'child') {
  log('service.child');
} else {
  log('service.start');
  spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore', env: process.env });
}
setInterval(() => {}, 1000);
`;

const STUCK_SERVICE_APP = `app: {
      services: [{
        name: 'stuck',
        executable: process.execPath,
        args: ['service.cjs'],
        env: { SIGNAL_LOG: process.env.SIGNAL_LOG },
        readyUrl: 'http://127.0.0.1:1/',
        startupTimeout: 600_000,
        shutdownTimeout: 600_000,
      }],
    },`;

/** A body that never calls the harness: only the interrupt race can end it. */
const SLEEPING_TEST = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

${LOG_HELPER}

test('sleeps until interrupted', async () => {
  log('test.start');
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});
`;

/**
 * The same body behind an `afterEach` that will not end on its own: the
 * graceful path then spends the whole cleanup budget in the hook, so a second
 * signal is guaranteed to land mid-teardown.
 */
const SLOW_TEARDOWN_TEST = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

${LOG_HELPER}

test.afterEach(async () => {
  log('afterEach.start');
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});

test('sleeps until interrupted', async () => {
  log('test.start');
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});
`;

interface RunningCli {
  readonly child: ChildProcess;
  readonly projectDir: string;
  /** The pid of the worker that started the test. */
  readonly workerPid: number;
  readonly exit: Promise<number | null>;
  /** Engine and fixture events logged so far, pid prefix stripped. */
  events(): string[];
  /** The pids that logged `event`, in order. */
  pids(event: string): number[];
  output(): string;
  signalGroup(signal: NodeJS.Signals): void;
}

interface Fixture {
  readonly files: Record<string, string>;
  /** The logged event that marks the run as far along as the body needs it. */
  readonly until: string;
}

/** A project whose test is `testSource`; the run is handed over once the test body has started. */
function sleepingProject(testSource: string): Fixture {
  return { files: { 'e2e.config.ts': config(), 'tests/sleep.e2e.ts': testSource }, until: 'test.start' };
}

/**
 * Runs the CLI on a fresh project in its own process group — a terminal's
 * foreground job — until the fixture's `until` event was logged, hands it to
 * the body, and always kills the group and removes the project afterwards.
 */
async function withRunningCli(fixture: Fixture, body: (run: RunningCli) => Promise<void>): Promise<void> {
  const project = createProject(fixture.files);
  const logPath = path.join(project.dir, 'signals.log');
  const chunks: string[] = [];
  const child = spawn(process.execPath, [CLI, 'run'], {
    cwd: project.dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SIGNAL_LOG: logPath, CI: '' },
  });
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  const lines = (): string[] =>
    existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const run: RunningCli = {
    child,
    projectDir: project.dir,
    get workerPid() {
      const line = lines().find((entry) => entry.endsWith(' test.start'));
      if (line === undefined) throw new Error('the test never started');
      return Number.parseInt(line.split(' ')[0]!, 10);
    },
    exit,
    events: () => lines().map((line) => line.split(' ').slice(1).join(' ')),
    pids: (event) =>
      lines()
        .filter((line) => line.endsWith(` ${event}`))
        .map((line) => Number.parseInt(line.split(' ')[0]!, 10)),
    output: () => chunks.join(''),
    signalGroup: (signal) => {
      if (child.pid === undefined) throw new Error('child has no pid');
      process.kill(-child.pid, signal);
    },
  };
  try {
    await waitFor(() => run.events().includes(fixture.until), 25_000, `the fixture to log ${fixture.until}`);
    await body(run);
  } finally {
    try {
      run.signalGroup('SIGKILL');
    } catch {
      // already gone
    }
    project.cleanup();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('interrupt signals against the CLI', () => {
  it(
    'one Ctrl-C ends a sleeping test at once, disposes the engine, and exits 130',
    () =>
      withRunningCli(sleepingProject(SLEEPING_TEST), async (run) => {
        const interruptedAt = Date.now();
        run.signalGroup('SIGINT');
        const code = await run.exit;
        const elapsed = Date.now() - interruptedAt;

        expect(code).toBe(130);
        // Well inside the 60 s test timeout: the interrupt, not the timeout, ended the body.
        expect(elapsed).toBeLessThan(20_000);
        expect(run.events()).toEqual(['init', 'startAttempt', 'test.start', 'endAttempt', 'dispose']);
        expect(run.output()).toContain('interrupted: stopping the running test');
        expect(alive(run.workerPid)).toBe(false);
      }),
    60_000,
  );

  it(
    'a second Ctrl-C forces the worker to dispose now and still exits 130 with a report',
    () =>
      withRunningCli(sleepingProject(SLOW_TEARDOWN_TEST), async (run) => {
        run.signalGroup('SIGINT');
        // The first interrupt ended the body; teardown is now stuck in the hook.
        await waitFor(() => run.events().includes('afterEach.start'), 10_000, 'the afterEach hook to start');
        const forcedAt = Date.now();
        run.signalGroup('SIGINT');
        const code = await run.exit;

        expect(code).toBe(130);
        // The hook alone would have held the run for the whole cleanup budget.
        expect(Date.now() - forcedAt).toBeLessThan(CLEANUP_TIMEOUT_MS - 1_000);
        expect(run.output()).toContain('interrupted again');
        expect(existsSync(path.join(run.projectDir, '.e2e', 'report.json'))).toBe(true);
        const pid = run.workerPid;
        await waitFor(() => !alive(pid), CLEANUP_TIMEOUT_MS + 5_000, 'the worker to exit');
        expect(run.events()).toContain('dispose');
      }),
    60_000,
  );

  it(
    'a worker whose runner is killed disposes its engine and exits on its own',
    () =>
      withRunningCli(sleepingProject(SLEEPING_TEST), async (run) => {
        const pid = run.workerPid;
        expect(alive(pid)).toBe(true);
        // Only the runner dies; the worker learns of it through its IPC channel closing.
        run.child.kill('SIGKILL');
        await run.exit;

        await waitFor(() => !alive(pid), CLEANUP_TIMEOUT_MS + 5_000, 'the orphaned worker to exit');
        expect(run.events()).toContain('dispose');
      }),
    60_000,
  );

  it(
    'a third Ctrl-C during services startup exits at once and takes the service process group with it',
    () =>
      withRunningCli(
        {
          // The run collects before it starts any process, so the project
          // needs a test for the service to start at all; it never runs.
          files: {
            'e2e.config.ts': config(STUCK_SERVICE_APP),
            'service.cjs': STUCK_SERVICE,
            'tests/sleep.e2e.ts': SLEEPING_TEST,
          },
          until: 'service.child',
        },
        async (run) => {
          const [servicePid] = run.pids('service.start');
          const [grandchildPid] = run.pids('service.child');
          if (servicePid === undefined || grandchildPid === undefined) throw new Error('the service never started');
          try {
            expect(alive(servicePid)).toBe(true);
            expect(alive(grandchildPid)).toBe(true);

            // Interrupt: the runner stops the service, which ignores SIGTERM and would hold it for shutdownTimeout.
            run.signalGroup('SIGINT');
            await waitFor(() => run.output().includes('interrupted'), 10_000, 'the interrupt notice');
            expect(alive(servicePid)).toBe(true);
            // Force: nothing runs yet, so the stop is still stuck. Then the last resort.
            run.signalGroup('SIGINT');
            await waitFor(() => run.output().includes('interrupted again'), 10_000, 'the force notice');
            const forcedExitAt = Date.now();
            run.signalGroup('SIGINT');
            const code = await run.exit;

            expect(code).toBe(130);
            expect(Date.now() - forcedExitAt).toBeLessThan(5_000);
            await waitFor(() => !alive(servicePid) && !alive(grandchildPid), 5_000, 'the service group to die');
          } finally {
            // The service lives in its own process group; on failure, do not leave it behind.
            for (const pid of [servicePid, grandchildPid]) {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                // already gone
              }
            }
          }
        },
      ),
    60_000,
  );
});
