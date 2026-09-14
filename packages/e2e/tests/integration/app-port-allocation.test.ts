import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playwright } from '@e2edev/playwright';
import type { E2EConfig } from '../../src/index.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  createProject,
  runExisting,
  runProjectWithConfigFile,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

/** A server that listens where the runner tells it to. */
const SERVER = `require('node:http')
  .createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Port app</title><h1>Served on ' + process.env.PORT + '</h1>');
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
`;

const TITLE = 'reads the allocated base URL';

/** Appends what the test saw, one line per attempt: the fixture's base URL beside where the browser landed. */
const TEST = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

test('${TITLE}', async ({ app, web }) => {
  await app.open('/');
  appendFileSync(process.env.PORT_URLS!, JSON.stringify({ baseUrl: app.baseUrl, current: await web.url() }) + '\\n');
});
`;

const FILES = { 'tests/port.e2e.ts': TEST, 'server.cjs': SERVER };

const DECLARATION = {
  url: 'http://127.0.0.1:0',
  command: { executable: process.execPath, args: ['server.cjs'], env: { PORT: '{port}' } },
};

/** The same declaration as a config file, so the worker path re-resolves it from disk. */
const CONFIG_SOURCE = `import type { E2EConfig } from 'e2e';
import { playwright } from '@e2edev/playwright';

export default {
  targets: [{
    name: 'web',
    engine: playwright({
      url: 'http://127.0.0.1:0',
      command: { executable: process.execPath, args: ['server.cjs'], env: { PORT: '{port}' } },
    }),
  }],
  workers: 1,
} satisfies E2EConfig;
`;

/** One target per name, every one asking for its own port with the same declaration. */
function targets(names: readonly string[]): NonNullable<E2EConfig['targets']> {
  return names.map((name) => ({ name, engine: playwright(DECLARATION) })) as unknown as NonNullable<
    E2EConfig['targets']
  >;
}

/**
 * Asserts one run served every target on a real port of its own and told the
 * test about it: each attempt landed on its fixture's base URL, the ports are
 * distinct, and the report records the same origins.
 */
function expectAllocatedRun(outcome: RunOutcome, urlsPath: string, names: readonly string[]): void {
  expect(outcome.report.run.errors).toEqual([]);
  expect(outcome.exitCode).toBe(0);
  const results = outcome.results.filter((result) => result.test.title === TITLE);
  expect(results.map((result) => [result.target.name, result.status])).toEqual(names.map((name) => [name, 'passed']));
  const seen = readFileSync(urlsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { baseUrl: string; current: string });
  expect(seen).toHaveLength(names.length);
  const ports = seen.map(({ baseUrl, current }) => {
    const port = Number(new URL(baseUrl).port);
    expect(port).toBeGreaterThan(0);
    expect(baseUrl).toBe(`http://127.0.0.1:${port}/`);
    expect(current).toBe(baseUrl);
    return port;
  });
  expect(new Set(ports).size).toBe(names.length);
  expect(outcome.report.run.targets.map((target) => target.baseOrigin).toSorted()).toEqual(
    ports.map((port) => `http://127.0.0.1:${port}`).toSorted(),
  );
  assertValidReport(outcome.report);
}

describe('app port allocation', () => {
  const previous = process.env['PORT_URLS'];
  let urlsPath: string;
  let project: FixtureProject | undefined;

  beforeEach(() => {
    // Outside the project: the worker-path helper creates the project itself,
    // and both the in-process test body and a worker inherit this env.
    urlsPath = path.join(os.tmpdir(), `e2e-port-urls-${process.pid}-${Date.now()}.json`);
    process.env['PORT_URLS'] = urlsPath;
  });

  afterEach(() => {
    project?.cleanup();
    project = undefined;
    rmSync(urlsPath, { force: true });
    if (previous === undefined) delete process.env['PORT_URLS'];
    else process.env['PORT_URLS'] = previous;
  });

  it(
    'serves the app on a port the run picked and hands tests the allocated base URL, run after run',
    async () => {
      project = createProject(FILES);
      const options = { appUrl: DECLARATION.url, config: { targets: targets(['web']) } };
      expectAllocatedRun(await runExisting(project, options), urlsPath, ['web']);
      rmSync(urlsPath);
      // A second run in the same process allocates again and the app follows.
      expectAllocatedRun(await runExisting(project, options), urlsPath, ['web']);
    },
    120_000,
  );

  it(
    'gives two targets asking for port 0 a distinct port and a server each',
    async () => {
      project = createProject(FILES);
      const names = ['first', 'second'];
      const outcome = await runExisting(project, { appUrl: DECLARATION.url, config: { targets: targets(names) } });
      expectAllocatedRun(outcome, urlsPath, names);
    },
    120_000,
  );

  it(
    'carries the assigned port to a worker process, which resolves the same config',
    async () => {
      const run = await runProjectWithConfigFile(FILES, { appUrl: DECLARATION.url, configSource: CONFIG_SOURCE });
      project = run.project;
      expectAllocatedRun(run.outcome, urlsPath, ['web']);
    },
    120_000,
  );
});
