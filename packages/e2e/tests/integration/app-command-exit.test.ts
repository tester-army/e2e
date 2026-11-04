import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { freePort } from '../helpers/free-port.ts';
import { createProject, runExistingWithConfigFile } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const SECRET = 'app-exit-test-secret-42';
const EXIT_MODES = [
  { mode: '1', description: 'exit code 1', detail: 'exited with code 1' },
  { mode: '0', description: 'exit code 0', detail: 'exited with code 0' },
  { mode: 'SIGTERM', description: 'SIGTERM', detail: 'was terminated by SIGTERM' },
] as const;

const SERVER = `const fs = require('node:fs');
require('node:http').createServer((_request, response) => response.end('ready'))
  .listen(Number(process.argv[2]), '127.0.0.1');
const timer = setInterval(() => {
  if (!fs.existsSync('exit-now')) return;
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
});
