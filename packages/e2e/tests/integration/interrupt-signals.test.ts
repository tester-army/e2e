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

const CONFIG = `import { appendFileSync } from 'node:fs';
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
    async init() { log('init'); },
    async startAttempt() { log('startAttempt'); },
    async endAttempt() { log('endAttempt'); },
    async dispose() { log('dispose'); },
    async observe() { return { nodes: [node] }; },
    async locate() { return [node]; },
    async url() { return 'app://fake/Home'; },
  }) }],
  timeout: 60_000,
  cleanupTimeout: ${CLEANUP_TIMEOUT_MS},
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;

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
  output(): string;
  signalGroup(signal: NodeJS.Signals): void;
}

/**
 * Runs the CLI on a fresh project in its own process group — a terminal's
 * foreground job — until the test body has started, hands it to the body,
 * and always kills the group and removes the project afterwards.
 */
async function withRunningTest(testSource: string, body: (run: RunningCli) => Promise<void>): Promise<void> {
  const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/sleep.e2e.ts': testSource });
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
    output: () => chunks.join(''),
    signalGroup: (signal) => {
      if (child.pid === undefined) throw new Error('child has no pid');
      process.kill(-child.pid, signal);
    },
  };
  try {
    await waitFor(() => run.events().includes('test.start'), 25_000, 'the test to start');
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
      withRunningTest(SLEEPING_TEST, async (run) => {
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
      withRunningTest(SLOW_TEARDOWN_TEST, async (run) => {
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
      withRunningTest(SLEEPING_TEST, async (run) => {
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
});
