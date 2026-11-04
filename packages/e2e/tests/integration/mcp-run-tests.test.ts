/**
 * `run_tests` over the built CLI and a real MCP client: the whole suite and
 * one file or one test, each the CLI's own run with its exit code and the
 * list reporter's text, progress per printed line, a secret a failure
 * carries redacted, a selection that matches nothing and a file that reads
 * as a flag as error results, one run at a time, a cancelled call
 * interrupting its run, a run beside an open session leaving that session
 * alive, and no run outliving the server: not on shutdown with a run
 * queued behind a cancelled one, and not when the server is killed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const SECRET = 'sk-live-RUNTESTS-4242';
const STARTED = 'slow test started';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  secrets: { apiKey: process.env.API_KEY! },
  actionTimeout: 1_000,
  retries: 0,
} satisfies E2EConfig;
`;

const PASSING = `import { expect, test } from 'e2e';

test('counts to one', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});

test('opens about', async ({ app }) => {
  await app.open('/about');
});
`;

const FAILING = `import { test } from 'e2e';

test('leaks its key in a failure', async ({ app }) => {
  await app.open('/');
  throw new Error('rejected key ' + process.env.API_KEY);
});
`;

const LOUD = `import { test } from 'e2e';

test('prints many long lines', async () => {
  for (let line = 0; line < 20; line += 1) console.log(String(line).padEnd(9_000, 'x'));
  throw new Error('after the long lines');
});
`;

// The slow tests sit outside the default config's tests, so the whole suite never waits on them.
const slowConfig = (glob: string): string => CONFIG.replace('retries: 0,', `retries: 0,\n  tests: ['${glob}'],`);

const SLOW = `import { test } from 'e2e';

test('takes its time', async ({ app }) => {
  await app.open('/');
  console.log(${JSON.stringify(STARTED)});
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;

interface RunResult {
  readonly text: string;
  readonly isError: boolean;
  readonly progress: string[];
}

/** The `e2e run` processes still alive whose command line names `config`; POSIX `ps`, so the tests using it skip on Windows. */
function runsAlive(config: string): string[] {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  return lines.filter((line) => line.includes('bin.js run') && line.includes(config));
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

describe('e2e mcp run_tests', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;

  const connect = async (): Promise<{ client: Client; transport: StdioClientTransport }> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, API_KEY: SECRET, CI: '' },
      stderr: 'pipe',
    });
    const connected = new Client({ name: 'e2e-mcp-run-tests', version: '0.0.0' });
    await connected.connect(transport);
    return { client: connected, transport };
  };

  const runTests = async (
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (message: string) => void; on?: Client } = {},
  ): Promise<RunResult> => {
    const progress: string[] = [];
    const result = (await (options.on ?? client).callTool(
      { name: 'run_tests', arguments: args },
      {
        timeout: 110_000,
        onprogress: (event) => {
          progress.push(event.message ?? '');
          options.onProgress?.(event.message ?? '');
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: result.content.map((part) => part.text ?? '').join('\n'), isError: result.isError === true, progress };
  };

  /** Starts a slow run and resolves once its test is running, with the call still in flight (boxed, or awaiting would wait for it). */
  const startSlow = async (config: string, on?: Client, signal?: AbortSignal): Promise<{ readonly call: Promise<unknown> }> => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const call = runTests({ config }, { ...(signal === undefined ? {} : { signal }), ...(on === undefined ? {} : { on }), onProgress: (line) => line.includes(STARTED) && started() }).catch(
      (cause: unknown) => cause,
    );
    await Promise.race([running, call]);
    return { call };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'e2e.config.ts': CONFIG,
      'tests/passing.e2e.ts': PASSING,
      'tests/failing.e2e.ts': FAILING,
      'loud/loud.e2e.ts': LOUD,
      'loud.config.ts': slowConfig('loud/**/*.e2e.ts'),
      'slow/slow.e2e.ts': SLOW,
      'slow.config.ts': slowConfig('slow/**/*.e2e.ts'),
      'slow-shutdown.config.ts': slowConfig('slow/**/*.e2e.ts'),
      'slow-killed.config.ts': slowConfig('slow/**/*.e2e.ts'),
      'queued.config.ts': CONFIG,
    });
    ({ client } = await connect());
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('lists run_tests beside the session tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['open_session', 'tools', 'call', 'close_session', 'run_tests']);
    expect(client.getInstructions()).toContain('run_tests');
  });

  it('runs one file as e2e run does, with progress per line', async () => {
    const run = await runTests({ files: ['tests/passing.e2e.ts'] });
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toMatch(/^e2e run -- tests\/passing\.e2e\.ts\nexit 0: every selected test passed, was flaky, or was skipped\n/);
    expect(run.text).toContain('tests/passing.e2e.ts > counts to one');
    expect(run.text).toContain('Tests  2 passed (2)');
    expect(run.text).not.toContain('\u001B[');
    expect(run.progress.some((line) => line.includes('counts to one'))).toBe(true);
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(true);
  });

  it('runs one test by file:line', async () => {
    const run = await runTests({ files: ['tests/passing.e2e.ts:9'] });
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toContain('Tests  1 passed (1)');
    expect(run.text).toContain('opens about');
    expect(run.text).not.toContain('counts to one');
  });

  it('runs the whole suite and reports a failure as the run result, with the secret redacted', async () => {
    const run = await runTests({});
    expect(run.text).toMatch(/^e2e run\n/);
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toContain('exit 1: a test failed or timed out');
    expect(run.text).toContain('leaks its key in a failure');
    expect(run.text).toContain('rejected key');
    expect(run.text).not.toContain(SECRET);
    expect(run.text).toContain('2 passed');
    expect(run.text).toContain('1 failed');

    const again = await runTests({ lastFailed: true, retries: 0 });
    expect(again.text).toMatch(/^e2e run --last-failed --retries=0\n/);
    expect(again.text).toContain('Tests  1 failed | 0 passed (1)');
  });

  it('keeps the end of an output too long for one result, and bounds each progress line', async () => {
    const run = await runTests({ config: 'loud.config.ts' });
    expect(run.text).toContain('exit 1');
    expect(run.text).toMatch(/earlier characters cut; the run's report\.json/);
    expect(run.text).toContain('after the long lines');
    expect(run.text.length).toBeLessThan(65_000);
    expect(Math.max(...run.progress.map((line) => line.length))).toBeLessThanOrEqual(1_001);
  });

  it('returns a selection that matches nothing as an error result', async () => {
    const run = await runTests({ files: ['tests/missing.e2e.ts'] });
    expect(run.isError).toBe(true);
    expect(run.text).toContain('exit 2: CLI, config, or agent policy error');
    expect(run.text).toContain('NO_TESTS');
  });

  it('refuses a file that reads as a flag, an empty target list, and raw flags', async () => {
    const asFile = await runTests({ files: ['--watch'] });
    expect(asFile.isError).toBe(true);
    expect(asFile.text).toContain('a file cannot start with "-"');
    const raw = await runTests({ flags: ['--watch'] });
    expect(raw.isError).toBe(true);
    expect(raw.text).toContain('Unrecognized key: "flags"');
    const noTargets = await runTests({ target: [] });
    expect(noTargets.isError).toBe(true);
    expect(noTargets.text).toContain('target');
  });

  it.skipIf(process.platform === 'win32')('runs one suite at a time, and a cancelled call interrupts its run before the next starts', async () => {
    const cancel = new AbortController();
    const { call: slow } = await startSlow('slow.config.ts', undefined, cancel.signal);
    const busy = await runTests({ files: ['tests/passing.e2e.ts'] });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain('RUNNER_BUSY');

    const started = Date.now();
    cancel.abort();
    await slow;
    // The next run waits for the interrupted one to exit, long before the slow test would have ended.
    const next = await runTests({ files: ['tests/passing.e2e.ts'] });
    expect(next.text, next.text).toContain('exit 0');
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(runsAlive('slow.config.ts')).toEqual([]);
  });

  it('runs beside an open session and leaves it open', async () => {
    const opened = (await client.callTool({ name: 'open_session', arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
    expect(opened.isError, opened.content[0]?.text).not.toBe(true);
    const run = await runTests({ files: ['tests/passing.e2e.ts'] });
    expect(run.text).toContain('exit 0');
    const observed = (await client.callTool({ name: 'call', arguments: { tool: 'observe' } })) as { isError?: boolean };
    expect(observed.isError).not.toBe(true);
    await client.callTool({ name: 'close_session', arguments: {} });
  });

  it.skipIf(process.platform === 'win32')('starts no queued run once the server shuts down, and stops the one in flight', async () => {
    const { client: other } = await connect();
    const cancel = new AbortController();
    const { call: slow } = await startSlow('slow-shutdown.config.ts', other, cancel.signal);
    cancel.abort();
    // Queued behind the cancelled run: the shutdown must refuse it, not start it once the first exits.
    const queued = runTests({ config: 'queued.config.ts' }, { on: other }).catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await other.close();
    await Promise.all([slow, queued]);
    expect(await until(() => runsAlive('slow-shutdown.config.ts').length === 0, 45_000)).toBe(true);
    // Long enough for a wrongly admitted queued run to have spawned.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(runsAlive('queued.config.ts')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('interrupts its run when the server is killed', async () => {
    const { client: other, transport } = await connect();
    const { call: slow } = await startSlow('slow-killed.config.ts', other);
    expect(runsAlive('slow-killed.config.ts')).not.toEqual([]);
    process.kill(transport.pid!, 'SIGKILL');
    await slow;
    // The CLI notices its channel closed and climbs its own ladder; the test's 60 s sleep is cut short.
    expect(await until(() => runsAlive('slow-killed.config.ts').length === 0, 45_000)).toBe(true);
    await other.close().catch(() => undefined);
  });
});
