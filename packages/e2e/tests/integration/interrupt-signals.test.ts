/**
 * Ctrl-C against the built CLI, the way a terminal delivers it: SIGINT to the
 * whole process group, runner and workers alike. The backend is a file-logging
 * fake declared in the fixture config, so the test can see, from outside,
 * whether the backend was disposed and whether the worker outlived the runner.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** Cleanup budget of the fixture config; every teardown here is bounded by it. */
const CLEANUP_TIMEOUT_MS = 5_000;

const CONFIG = `import { appendFileSync } from 'node:fs';
import { defineConfig } from '@e2edev/e2e';
import { defineBackend } from '@e2edev/e2e/backend';

const log = (line) => appendFileSync(process.env.SIGNAL_LOG, \`\${process.pid} \${line}\\n\`);
const node = { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go', states: { hidden: false } };

export default defineConfig({
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'ios', backend: defineBackend({
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
});
`;

/** A body that never calls the harness: only the interrupt race can end it. */
const SLEEPING_TEST = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

test('sleeps until interrupted', async () => {
  appendFileSync(process.env.SIGNAL_LOG, \`\${process.pid} test.start\\n\`);
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});
`;

/**
 * The same sleeping body behind an `afterEach` that will not end on its own:
 * the graceful path then spends the whole cleanup budget in the hook, so a
 * second signal is guaranteed to land mid-teardown.
 */
const SLOW_TEARDOWN_TEST = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (line) => appendFileSync(process.env.SIGNAL_LOG, \`\${process.pid} \${line}\\n\`);

test.afterEach(async () => {
  log('afterEach.start');
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});

test('sleeps until interrupted', async () => {
  log('test.start');
  await new Promise((resolve) => setTimeout(resolve, 600_000));
});
`;

interface Launched {
  readonly child: ChildProcess;
  readonly logPath: string;
  readonly exit: Promise<number | null>;
  readonly output: () => string;
}

/** Starts the CLI in its own process group, as a terminal's foreground job. */
function launch(project: FixtureProject): Launched {
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
  return { child, logPath, exit, output: () => chunks.join('') };
}

function readLog(logPath: string): string[] {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** Lines of the log without their pid prefix. */
function events(logPath: string): string[] {
  return readLog(logPath).map((line) => line.split(' ').slice(1).join(' '));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) throw new Error('child has no pid');
  process.kill(-child.pid, signal);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of the worker that ran the test, from the log line it wrote. */
function workerPid(logPath: string): number {
  const line = readLog(logPath).find((entry) => entry.endsWith(' test.start'));
  if (line === undefined) throw new Error('the test never started');
  return Number.parseInt(line.split(' ')[0]!, 10);
}

async function killGroupIfAlive(child: ChildProcess): Promise<void> {
  try {
    signalGroup(child, 'SIGKILL');
  } catch {
    // already gone
  }
}

describe('interrupt signals against the CLI', () => {
  it(
    'one Ctrl-C ends a sleeping test at once, disposes the backend, and exits 130',
    async () => {
      const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/sleep.e2e.ts': SLEEPING_TEST });
      const run = launch(project);
      try {
        await waitFor(() => events(run.logPath).includes('test.start'), 25_000, 'the test to start');
        const interruptedAt = Date.now();
        signalGroup(run.child, 'SIGINT');
        const code = await run.exit;
        const elapsed = Date.now() - interruptedAt;

        expect(code).toBe(130);
        // Well inside the 60 s test timeout: the interrupt, not the timeout, ended the body.
        expect(elapsed).toBeLessThan(20_000);
        expect(events(run.logPath)).toEqual(['init', 'startAttempt', 'test.start', 'endAttempt', 'dispose']);
        expect(run.output()).toContain('interrupted: stopping the running test');
        expect(run.output()).toContain('interrupted');
        expect(alive(workerPid(run.logPath))).toBe(false);
      } finally {
        await killGroupIfAlive(run.child);
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'a second Ctrl-C forces the worker to dispose now and still exits 130 with a report',
    async () => {
      const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/sleep.e2e.ts': SLOW_TEARDOWN_TEST });
      const run = launch(project);
      try {
        await waitFor(() => events(run.logPath).includes('test.start'), 25_000, 'the test to start');
        signalGroup(run.child, 'SIGINT');
        // The first interrupt ended the body; teardown is now stuck in the hook.
        await waitFor(() => events(run.logPath).includes('afterEach.start'), 10_000, 'the afterEach hook to start');
        const forcedAt = Date.now();
        signalGroup(run.child, 'SIGINT');
        const code = await run.exit;

        expect(code).toBe(130);
        // The hook alone would have held the run for the whole cleanup budget.
        expect(Date.now() - forcedAt).toBeLessThan(CLEANUP_TIMEOUT_MS - 1_000);
        expect(run.output()).toContain('interrupted again');
        expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(true);
        // The runner is gone; the worker must not be left behind driving the backend.
        const pid = workerPid(run.logPath);
        await waitFor(() => !alive(pid), CLEANUP_TIMEOUT_MS + 5_000, 'the worker to exit');
        expect(events(run.logPath)).toContain('dispose');
      } finally {
        await killGroupIfAlive(run.child);
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'a worker whose runner is killed disposes its backend and exits on its own',
    async () => {
      const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/sleep.e2e.ts': SLEEPING_TEST });
      const run = launch(project);
      try {
        await waitFor(() => events(run.logPath).includes('test.start'), 25_000, 'the test to start');
        const pid = workerPid(run.logPath);
        expect(alive(pid)).toBe(true);
        // Only the runner dies; the worker learns of it through its IPC channel closing.
        run.child.kill('SIGKILL');
        await run.exit;

        await waitFor(() => !alive(pid), CLEANUP_TIMEOUT_MS + 5_000, 'the orphaned worker to exit');
        expect(events(run.logPath)).toContain('dispose');
      } finally {
        await killGroupIfAlive(run.child);
        project.cleanup();
      }
    },
    60_000,
  );
});
