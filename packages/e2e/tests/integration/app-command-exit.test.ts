import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { createProject, runExisting, runExistingWithConfigFile } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const SECRET = 'app-exit-test-secret-42';
const EXIT_MODES = [
  { mode: '1', description: 'exit code 1', detail: 'exited with code 1' },
  { mode: '0', description: 'exit code 0', detail: 'exited with code 0' },
  { mode: 'SIGTERM', description: 'SIGTERM', detail: 'was terminated by SIGTERM' },
] as const;

const SERVER = `const fs = require('node:fs');
const control = process.argv[4] ?? '';
fs.appendFileSync('starts', control + '\\n');
require('node:http').createServer((_request, response) => response.end('ready'))
  .listen(Number(process.argv[2]), '127.0.0.1');
const timer = setInterval(() => {
  if (!fs.existsSync(control + 'exit-now')) return;
  clearInterval(timer);
  const lines = Array.from({ length: 30 }, (_, index) => 'app output ' + index);
  lines.push('app exiting intentionally: ' + process.env.APP_SECRET);
  fs.writeSync(1, lines.join('\\n') + '\\n');
  const mode = process.argv[3];
  if (mode === 'SIGTERM') process.kill(process.pid, 'SIGTERM');
  else process.exit(Number(mode));
}, 10);
`;

const TESTS = `import { writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('waits while the app exits', async () => {
  writeFileSync('exit-now', 'requested');
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
test('queued test', async () => {
  writeFileSync('queued-ran', 'ran');
});
`;

const WAIT_FOR_FILE = `async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + file);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}`;

/** Builds a file-backed config for managed app targets. */
function managedConfig(
  targets: readonly { name: string; port: number; control: string }[],
  timeout = 10000,
  cleanupTimeout = 2000,
): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine } from '../../helpers/fake-engine.ts';
export default {
  workers: 2,
  timeout: ${timeout},
  cleanupTimeout: ${cleanupTimeout},
  targets: [${targets.map(({ name, port, control }) => `{
    name: '${name}', platform: 'fake', engine: createFakeEngine().engine,
    app: { url: 'http://127.0.0.1:${port}', command: {
      executable: ${JSON.stringify(process.execPath)},
      args: ['server.cjs', '${port}', '1', '${control}'],
      log: '.e2e/logs/${control}app.log',
      shutdownTimeout: 1000,
    } },
  }`).join(',')}],
} satisfies E2EConfig;
`;
}

describe('app command exits after readiness', () => {
  for (const { mode, description, detail } of EXIT_MODES) {
    it.skipIf(process.platform === 'win32' && mode === 'SIGTERM')(`fails the run and stops queued tests after ${description}`, async () => {
      const port = await freePort();
      const project = createProject({
        'server.cjs': SERVER,
        'tests/exit.e2e.ts': TESTS,
        'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { createFakeEngine } from '../../helpers/fake-engine.ts';
export default {
  workers: 1,
  timeout: 5000,
  cleanupTimeout: 2000,
  targets: [{ name: 'managed-app', platform: 'fake', engine: createFakeEngine({ state: true }).engine,
    app: { url: 'http://127.0.0.1:${port}', command: {
      executable: ${JSON.stringify(process.execPath)},
      args: ['server.cjs', '${port}', '${mode}'],
      env: { APP_SECRET: '${SECRET}' },
      log: '.e2e/logs/app.log',
      shutdownTimeout: 1000,
    } },
  }],
} satisfies E2EConfig;
`,
      });
      try {
        const outcome = await runExistingWithConfigFile(project, {});
        expect(existsSync(path.join(project.dir, 'exit-now'))).toBe(true);
        expect(readFileSync(path.join(project.dir, '.e2e/logs/app.log'), 'utf8')).toContain(`app exiting intentionally: ${SECRET}`);
        expect.soft(outcome.exitCode).toBe(3);
        expect.soft(outcome.report.run.errors).toEqual([
          expect.objectContaining({
            category: 'infrastructure',
            code: 'APP_UNREACHABLE',
            message: expect.stringContaining(`target "managed-app" command ${detail}`),
          }),
        ]);
        const message = outcome.report.run.errors[0]?.message ?? '';
        expect.soft(message).toContain('app output 29');
        expect.soft(message).toContain('app exiting intentionally: <secret:APP_SECRET>');
        expect.soft(message).not.toContain('app output 0\n');
        expect.soft(JSON.stringify(outcome.report)).not.toContain(SECRET);
        expect.soft(existsSync(path.join(project.dir, 'queued-ran'))).toBe(false);
        expect.soft(outcome.results.find((result) => result.test.title === 'waits while the app exits')?.status).toBe('interrupted');
        expect.soft(outcome.results.find((result) => result.test.title === 'queued test')?.status).toBe('skipped');
        assertValidReport(outcome.report);
      } finally {
        project.cleanup();
      }
    });
  }

  it('records a blocked active test as interrupted when the app exit forces its worker to be killed', async () => {
    const port = await freePort();
    const project = createProject({
      'server.cjs': SERVER,
      'e2e.config.ts': managedConfig([{ name: 'a', port, control: 'a-' }], 500, 200),
      'tests/blocked.e2e.ts': `import { writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('blocked active test', async () => {
  writeFileSync('a-exit-now', 'requested');
  while (true) {}
});
test('queued test', async () => { writeFileSync('queued-ran', 'ran'); });`,
    });
    try {
      const outcome = await runExistingWithConfigFile(project, {});
      expect(outcome.exitCode).toBe(3);
      expect(outcome.report.run.errors.map((error) => error.code)).toEqual(['APP_UNREACHABLE']);
      const active = outcome.results.find((result) => result.test.title === 'blocked active test');
      expect(active?.status).toBe('interrupted');
      expect(active?.attempts).toEqual([expect.objectContaining({ status: 'interrupted', cleanup: 'forced' })]);
      expect(outcome.results.find((result) => result.test.title === 'queued test')?.status).toBe('skipped');
      expect(existsSync(path.join(project.dir, 'queued-ran'))).toBe(false);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('keeps a passing run successful when the app exits during engine disposal', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const project = createProject({
      'server.cjs': SERVER,
      'tests/pass.e2e.ts': `import { test } from 'e2e';
test('passes before disposal', async () => {});`,
    });
    const fake = createFakeEngine({
      async onDispose() {
        writeFileSync(path.join(project.dir, 'exit-now'), 'requested');
        await expect.poll(() => fetch(url).then(() => true, () => false)).toBe(false);
      },
    });
    try {
      const outcome = await runExisting(project, {
        config: {
          targets: [{ name: 'finished', platform: 'fake', engine: fake.engine,
            app: { url, command: { executable: process.execPath, args: ['server.cjs', String(port), '1'], shutdownTimeout: 1000 } },
          }],
        },
      });
      expect(existsSync(path.join(project.dir, 'exit-now'))).toBe(true);
      expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
      expect.soft(outcome.report.run.errors).toEqual([]);
      expect.soft(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('interrupts only the exited app target and lets another target finish running and queued tests', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const project = createProject({
      'server.cjs': SERVER,
      'e2e.config.ts': managedConfig([
        { name: 'a', port: portA, control: 'a-' },
        { name: 'b', port: portB, control: 'b-' },
      ]),
      'tests/targets.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
${WAIT_FOR_FILE}
test('running test', async ({ app }) => {
  if (new URL(app.baseUrl!).port === '${portA}') {
    await waitForFile('b-running');
    writeFileSync('a-exit-now', 'requested');
    await new Promise(() => {});
  } else {
    writeFileSync('b-running', 'started');
    await waitForFile('app-exit-observed');
    const response = await fetch(app.baseUrl!);
    if (!response.ok) throw new Error('healthy app stopped answering');
    writeFileSync('b-finished', 'finished');
  }
});
test('queued test', async ({ app }) => {
  writeFileSync(new URL(app.baseUrl!).port === '${portA}' ? 'a-queued-ran' : 'b-queued-ran', 'ran');
});`,
    });
    try {
      const outcome = await runExistingWithConfigFile(project, {
        runOptions: {
          onEvent(event) {
            if (event.type === 'run-error' && event.error.code === 'APP_UNREACHABLE') {
              writeFileSync(path.join(project.dir, 'app-exit-observed'), 'observed');
            }
          },
        },
      });
      expect(existsSync(path.join(project.dir, 'b-running'))).toBe(true);
      expect.soft(outcome.exitCode).toBe(3);
      expect.soft(outcome.report.run.errors).toEqual([
        expect.objectContaining({ code: 'APP_UNREACHABLE', message: expect.stringContaining('target "a" command exited with code 1') }),
      ]);
      const a = outcome.results.filter((result) => result.target.name === 'a');
      const b = outcome.results.filter((result) => result.target.name === 'b');
      expect.soft(a.map((result) => result.status)).toEqual(['interrupted', 'skipped']);
      expect.soft(a.find((result) => result.test.title === 'queued test')?.skip?.reason).toContain('target "a" command exited with code 1');
      expect.soft(b.map((result) => result.status)).toEqual(['passed', 'passed']);
      expect.soft(existsSync(path.join(project.dir, 'a-queued-ran'))).toBe(false);
      expect.soft(existsSync(path.join(project.dir, 'b-finished'))).toBe(true);
      expect.soft(existsSync(path.join(project.dir, 'b-queued-ran'))).toBe(true);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('stops every target sharing the exited command and starts that command only once', async () => {
    const port = await freePort();
    const project = createProject({
      'server.cjs': SERVER,
      'e2e.config.ts': managedConfig([
        { name: 'a', port, control: 'shared-' },
        { name: 'b', port, control: 'shared-' },
      ]),
      'tests/shared.e2e.ts': `import { readdirSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('running test', async () => {
  writeFileSync('running-' + process.pid, 'started');
  const deadline = Date.now() + 5000;
  while (readdirSync('.').filter((name) => name.startsWith('running-')).length < 2) {
    if (Date.now() >= deadline) throw new Error('both targets did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync('shared-exit-now', 'requested');
  await new Promise(() => {});
});
test('queued test', async () => {
  writeFileSync('queued-ran', 'ran');
});`,
    });
    try {
      const outcome = await runExistingWithConfigFile(project, {});
      expect(readFileSync(path.join(project.dir, 'starts'), 'utf8')).toBe('shared-\n');
      expect.soft(outcome.exitCode).toBe(3);
      expect.soft(outcome.report.run.errors).toEqual([
        expect.objectContaining({ code: 'APP_UNREACHABLE', message: expect.stringContaining('target "a" command exited with code 1') }),
      ]);
      for (const target of ['a', 'b']) {
        const results = outcome.results.filter((result) => result.target.name === target);
        expect.soft(results.map((result) => result.status)).toEqual(['interrupted', 'skipped']);
        expect.soft(results.find((result) => result.test.title === 'queued test')?.skip?.reason).toContain('command exited with code 1');
      }
      expect(existsSync(path.join(project.dir, 'queued-ran'))).toBe(false);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('ignores an app exit after its target completed while another target is still running', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const project = createProject({
      'server.cjs': SERVER,
      'e2e.config.ts': managedConfig([
        { name: 'a', port: portA, control: 'a-' },
        { name: 'b', port: portB, control: 'b-' },
      ]),
      'tests/completed.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
${WAIT_FOR_FILE}
test('completes its target', async ({ app }) => {
  if (new URL(app.baseUrl!).port === '${portA}') {
    await waitForFile('b-running');
  } else {
    writeFileSync('b-running', 'started');
    await waitForFile('a-completed');
    const deadline = Date.now() + 5000;
    while (await fetch('http://127.0.0.1:${portA}').then(() => true, () => false)) {
      if (Date.now() >= deadline) throw new Error('completed target app did not exit');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!(await fetch(app.baseUrl!)).ok) throw new Error('healthy app stopped answering');
    writeFileSync('b-finished', 'finished');
  }
});`,
    });
    try {
      const outcome = await runExistingWithConfigFile(project, {
        runOptions: {
          onEvent(event) {
            if (event.type === 'test-finished' && event.result.target.name === 'a' && event.result.status === 'passed') {
              writeFileSync(path.join(project.dir, 'a-completed'), 'completed');
              writeFileSync(path.join(project.dir, 'a-exit-now'), 'requested');
            }
          },
        },
      });
      expect(existsSync(path.join(project.dir, 'a-completed'))).toBe(true);
      expect.soft(existsSync(path.join(project.dir, 'b-finished'))).toBe(true);
      expect.soft(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
      expect.soft(outcome.report.run.errors).toEqual([]);
      expect.soft(outcome.exitCode).toBe(0);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });
});
