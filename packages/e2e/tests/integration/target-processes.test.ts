import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineAppDeclaration } from '../../src/engine/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const FILES = {
  'tests/selected.e2e.ts': `import { test } from '@e2edev/e2e';
test('selected test', async () => {});
`,
  'service.cjs': `require('node:fs').appendFileSync('startup.log', process.argv[2] + '\\n');`,
  'server.cjs': `require('node:fs').appendFileSync('startup.log', 'app\\n');
require('node:http').createServer((_request, response) => response.end('ready'))
  .listen(Number(process.argv[2]), '127.0.0.1');`,
};

/** Finds an available port for the app command's readiness endpoint. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

/** A completed dependency process that records its startup order. */
function service(name: string) {
  return { name, executable: process.execPath, args: ['service.cjs', name], waitForExit: true };
}

/** Two targets sharing an app and a third with processes that must stay stopped. */
function targets(port: number) {
  const url = `http://127.0.0.1:${port}`;
  const app: EngineAppDeclaration = {
    url,
    services: [service('first'), service('second')],
    command: { executable: process.execPath, args: ['server.cjs', String(port)] },
  };
  return [
    {
      name: 'unused',
      platform: 'fake',
      engine: createFakeEngine({
        app: {
          url,
          services: [service('first'), service('unused-service')],
          command: { executable: process.execPath, args: ['service.cjs', 'unused-command'] },
        },
      }).engine,
    },
    { name: 'selected-a', platform: 'fake', engine: createFakeEngine({ app }).engine },
    { name: 'selected-b', platform: 'fake', engine: createFakeEngine({ app }).engine },
  ];
}

describe('target process selection', () => {
  it('starts selected dependencies before their shared app, once each in config order', async () => {
    const project = createProject(FILES);
    const port = await freePort();
    try {
      const outcome = await runExisting(project, {
        appUrl: `http://127.0.0.1:${port}`,
        config: { targets: targets(port) },
        runOptions: { targetIds: ['selected-b', 'selected-a', 'selected-b'] },
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.results.map((result) => result.target.name)).toEqual(['selected-a', 'selected-b']);
      expect(readFileSync(path.join(project.dir, 'startup.log'), 'utf8')).toBe('first\nsecond\napp\n');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('rejects an unknown target with its suggestion before starting any process', async () => {
    const project = createProject(FILES);
    const port = await freePort();
    try {
      const outcome = await runExisting(project, {
        appUrl: `http://127.0.0.1:${port}`,
        config: { targets: targets(port) },
        runOptions: { targetIds: ['selected-a', 'unusd'] },
      });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.results).toEqual([]);
      expect(outcome.report.run.errors).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_TARGET',
          phase: 'collection',
          message: 'unknown target ID "unusd"; the config declares "unused", "selected-a", "selected-b"; did you mean "unused"?',
        }),
      ]);
      expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('preserves an initial interrupt before validating target IDs or starting processes', async () => {
    const project = createProject(FILES);
    const port = await freePort();
    try {
      const outcome = await runExisting(project, {
        appUrl: `http://127.0.0.1:${port}`,
        config: { targets: targets(port) },
        runOptions: { targetIds: ['unknown'], interruptSignal: AbortSignal.abort() },
      });
      expect(outcome.status).toBe('interrupted');
      expect(outcome.results).toEqual([]);
      expect(outcome.report.run.errors).toEqual([]);
      expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });
});
