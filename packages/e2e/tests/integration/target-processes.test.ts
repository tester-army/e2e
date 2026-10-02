import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineService } from '../../src/services.ts';
import type { ServiceHandle, Target } from '../../src/types.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { createProject, resultByTitle, runExisting, runProjectWithConfigFile } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { STARTUP_SCRIPTS } from '../helpers/startup-scripts.ts';

/**
 * Appends what the test saw, one JSON line per attempt: the target, its base
 * URL, and what the server at that URL says its environment is.
 */
const SEEN_TEST = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';
test('selected test', async ({ app }) => {
  const env = await (await fetch(new URL('/env', app.baseUrl))).json();
  appendFileSync(new URL('../seen.log', import.meta.url), JSON.stringify({ baseUrl: app.baseUrl, env }) + '\\n');
});
`;

const FILES = {
  'tests/selected.e2e.ts': SEEN_TEST,
  ...STARTUP_SCRIPTS,
  // A dev server on the port it is handed, reporting the environment it was started with.
  'server.cjs': `require('node:fs').appendFileSync('startup.log', 'app\\n');
require('node:http').createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ STRIPE_API: process.env.STRIPE_API }));
}).listen(Number(process.argv[2]), '127.0.0.1');`,
};

/** A completed dependency process that records its startup order. */
function step(name: string, dependsOn: readonly ServiceHandle[] = []): ServiceHandle {
  return defineService({ name, executable: process.execPath, args: ['service.cjs', name], waitForExit: true, dependsOn });
}

/**
 * Two targets sharing one dev server on a free port, which depends on two
 * steps and an API mock whose address it is handed, and a third target with
 * services that must stay stopped.
 */
function targets(): Target[] {
  const first = step('first');
  const second = step('second', [first]);
  const api = defineService({
    name: 'api',
    executable: process.execPath,
    args: ['server.cjs', '{port}'],
    readyUrl: 'http://127.0.0.1:0/env',
  });
  const web = defineService({
    name: 'web',
    executable: process.execPath,
    args: ['server.cjs', '{port}'],
    env: { STRIPE_API: `${api.url}/v1` },
    readyUrl: 'http://127.0.0.1:0/env',
    dependsOn: [second, api],
  });
  return [
    { name: 'unused', platform: 'fake', engine: createFakeEngine().engine, app: { url: 'http://127.0.0.1:1' }, services: [step('unused-service', [first])] },
    { name: 'selected-a', platform: 'fake', engine: createFakeEngine().engine, app: { url: web.url }, services: [web] },
    { name: 'selected-b', platform: 'fake', engine: createFakeEngine().engine, app: { url: `${web.url}/b/` }, services: [web] },
  ];
}

/** What the test attempts recorded, in order. */
function seen(dir: string): { baseUrl: string; env: { STRIPE_API?: string } }[] {
  return readFileSync(path.join(dir, 'seen.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('target services', () => {
  it('starts each service the selected targets need once, dependencies first, on free ports the placeholders name', async () => {
    const project = createProject(FILES);
    try {
      const outcome = await runExisting(project, {
        appUrl: 'http://127.0.0.1:1',
        config: { targets: targets() },
        runOptions: { targetIds: ['selected-b', 'selected-a', 'selected-b'] },
      });
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.results.map((result) => result.target.name)).toEqual(['selected-a', 'selected-b']);
      // The api and the web server both run server.cjs: one "app" line each.
      expect(readFileSync(path.join(project.dir, 'startup.log'), 'utf8')).toBe('first\nsecond\napp\napp\n');
      const [a, b] = seen(project.dir);
      const port = Number(new URL(a!.baseUrl).port);
      expect(port).toBeGreaterThan(0);
      expect(a!.baseUrl).toBe(`http://127.0.0.1:${port}/`);
      expect(b!.baseUrl).toBe(`http://127.0.0.1:${port}/b/`);
      const api = new URL(a!.env.STRIPE_API!);
      expect(api.pathname).toBe('/v1');
      expect(Number(api.port)).toBeGreaterThan(0);
      expect(Number(api.port)).not.toBe(port);
      expect(outcome.report.run.targets.map((target) => target.baseOrigin)).toEqual(['http://127.0.0.1:1', `http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('rejects an unknown target with its suggestion before starting any process', async () => {
    const project = createProject(FILES);
    try {
      const outcome = await runExisting(project, {
        appUrl: 'http://127.0.0.1:1',
        config: { targets: targets() },
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
    try {
      const outcome = await runExisting(project, {
        appUrl: 'http://127.0.0.1:1',
        config: { targets: targets() },
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

  it('runs a function service around the whole run', async () => {
    const project = createProject({
      'tests/one.e2e.ts': `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';
test('first', async () => { appendFileSync(new URL('../lifetime.log', import.meta.url), 'first\\n'); });
test('second', async () => { appendFileSync(new URL('../lifetime.log', import.meta.url), 'second\\n'); });
`,
    });
    try {
      const log = path.join(project.dir, 'lifetime.log');
      const { appendFileSync } = await import('node:fs');
      const seed = defineService({
        name: 'seed',
        start: async () => appendFileSync(log, 'start\n'),
        stop: async () => appendFileSync(log, 'stop\n'),
      });
      const setup: string[] = [];
      const outcome = await runExisting(project, {
        appUrl: 'http://127.0.0.1:1',
        config: { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, services: [seed] }] },
        runOptions: {
          onEvent: (event) => {
            if (event.type === 'setup' && event.step.kind === 'service') setup.push(`${event.step.label} ${event.state}`);
          },
        },
      });
      expect(outcome.exitCode).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe('start\nfirst\nsecond\nstop\n');
      expect(setup).toEqual(['service "seed" started', 'service "seed" finished']);
    } finally {
      project.cleanup();
    }
  });
});

/** The same shared dev server as a config file, so child-process workers re-resolve it from disk. */
const CONFIG_SOURCE = `import type { E2EConfig } from 'e2e';
import { defineService } from 'e2e';
import { defineEngine } from 'e2e/engine';

const web = defineService({
  name: 'web',
  executable: process.execPath,
  args: ['server.cjs', '{port}'],
  readyUrl: 'http://127.0.0.1:0/env',
});

/** One engine per target, with nothing to drive: the test reads the app over HTTP. */
const engine = () => defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, platform: 'toy' });

export default {
  targets: [
    { name: 'a', engine: engine(), app: { url: web.url }, services: [web] },
    { name: 'b', engine: engine(), app: { url: web.url }, services: [web] },
  ],
  workers: 2,
  cache: 'off',
} satisfies E2EConfig;
`;

describe('target services across worker processes', () => {
  it('hands every worker the service ports in its bootstrap, so each resolves the same address', async () => {
    const { outcome, project } = await runProjectWithConfigFile(FILES, { appUrl: 'http://127.0.0.1:1', configSource: CONFIG_SOURCE });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(resultByTitle(outcome, 'selected test').status).toBe('passed');
      expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
      const urls = seen(project.dir).map((entry) => entry.baseUrl);
      expect(urls).toHaveLength(2);
      expect(new Set(urls).size).toBe(1);
      expect(Number(new URL(urls[0]!).port)).toBeGreaterThan(0);
      expect(readFileSync(path.join(project.dir, 'startup.log'), 'utf8')).toBe('app\n');
    } finally {
      project.cleanup();
    }
  });
});
