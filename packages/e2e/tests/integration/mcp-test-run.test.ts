/**
 * `open_session {test}`. Over the built CLI and a real MCP client, since a
 * vitest fork reports transformed source positions and a plain Node process
 * the ones users see: a passing test leaves the session on its final screen,
 * a failing one opens with its code, line, code frame, and the nodes nearest
 * its locator, and the session then observes the screen it failed on;
 * `afterEach` waits for `close_session`; a reopened session runs the test
 * files as they are now, and its actions print test lines that carry on from
 * the test; a promise a test left rejected fails that test
 * rather than the server, before and after its close; a body its timeout cut
 * short can't drive the session; a `beforeAll` failure is the outcome, once,
 * with no screen; a screenshot baseline one session wrote passes the next; a
 * name that selects no test, several, or one a session cannot run alone fails
 * before anything boots. In-process: the replay cache serves a session's test
 * as it serves `e2e run`, both ways, with a scripted model; two sessions
 * collect and run their tests one at a time; and an open cancelled while its
 * test waits for its turn runs none of it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { loopCalls } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, webTarget, type FixtureProject } from '../helpers/run-project.ts';
import { cacheConfig, entriesFor, expectReplayed, FLOWS, flowsModel, flowsSuite, onlyActStep } from '../helpers/trace-cache.ts';

const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');
const resolveModule = new URL('../../dist/config/resolve.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve.ts');

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  actionTimeout: 1_000,
} satisfies E2EConfig;
`;

const COUNTER = `import { writeFileSync } from 'node:fs';
import { expect, test } from 'e2e';
import { missing } from './label.ts';

test.afterEach(() => {
  writeFileSync(new URL('../after-each.txt', import.meta.url), 'ran');
});

test('counts to one', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});

test('taps a button that is not there', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await screen.getByRole('button', { name: missing }).tap();
});
`;

const OTHERS = `import { test } from 'e2e';

test('first', async ({ app }) => {
  await app.open('/');
});

test('second', async ({ app }) => {
  await app.open('/about');
});

test.describe('flow', { serial: true }, () => {
  test('step one', async ({ app }) => {
    await app.open('/');
  });
});

test('signed in', { session: 'member' }, async ({ app }) => {
  await app.open('/');
});
`;

const SLOPPY = `import { test } from 'e2e';

async function seed(): Promise<void> {
  throw new Error('seed endpoint returned 500');
}

test('forgets an await', async ({ app, screen }) => {
  await app.open('/');
  seed();
  await screen.getByRole('button', { name: 'Increment' }).tap();
});

test('leaves a promise behind', async ({ app }) => {
  await app.open('/');
  setTimeout(() => {
    void Promise.reject(new Error('late failure'));
  }, 50);
});

test('leaves a promise for after the close', async ({ app }) => {
  await app.open('/');
  setTimeout(() => {
    void Promise.reject(new Error('later failure'));
  }, 1_500);
});

test('outlives its timeout', { timeout: 1_000 }, async ({ app }) => {
  await app.open('/');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await app.open('/about');
});
`;

const HOOKS = `import { beforeAll, test } from 'e2e';

beforeAll(() => {
  throw new Error('database is down');
});

test('needs the database', async ({ app }) => {
  await app.open('/');
});
`;

const VISUAL = `import { expect, test } from 'e2e';

test('matches its screenshot', async ({ app, screen }) => {
  await app.open('/about');
  await expect(screen).toHaveScreenshot('about.png');
});
`;

const SETUP = `import { test } from 'e2e';

test.setup('member signs in', { sessions: ['member'] }, async ({ app, session }) => {
  await app.open('/');
  await session.save('member');
});
`;

/** The one-based line of the first line of `source` that holds `fragment`. */
const lineOf = (source: string, fragment: string): number => source.split('\n').findIndex((line) => line.includes(fragment)) + 1;

const PASSING = lineOf(COUNTER, "test('counts to one'");
const FAILING = lineOf(COUNTER, "test('taps a button");
const MISSING_TAP = lineOf(COUNTER, '{ name: missing }');

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

describe('open_session {test}', { timeout: 120_000 }, () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('over e2e mcp', () => {
    let project: FixtureProject;
    let client: Client;
    let stderr = '';

    const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
      const result = (await client.callTool({ name, arguments: args }, { timeout: 110_000 })) as { content: { type: string; text?: string }[]; isError?: boolean };
      return { text: result.content.map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
    };
    const observe = async (): Promise<string> => (await invoke('call', { tool: 'observe' })).text;

    beforeAll(async () => {
      project = createProject({
        'e2e.config.ts': CONFIG,
        'tests/counter.e2e.ts': COUNTER,
        'tests/label.ts': `export const missing = 'Incremnt';\n`,
        'tests/others.e2e.ts': OTHERS,
        'tests/auth.setup.e2e.ts': SETUP,
        'tests/sloppy.e2e.ts': SLOPPY,
        'tests/hooks.e2e.ts': HOOKS,
        'tests/visual.e2e.ts': VISUAL,
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        cwd: project.dir,
        env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      client = new Client({ name: 'e2e-mcp-test-run', version: '0.0.0' });
      await client.connect(transport);
    }, 60_000);

    afterAll(async () => {
      await client?.close().catch(() => undefined);
      project?.cleanup();
    });

    it('leaves a passing test on its final screen and runs its afterEach at close_session', async () => {
      const marker = path.join(project.dir, 'after-each.txt');
      const opened = await invoke('open_session', { test: `tests/counter.e2e.ts:${PASSING}` });
      expect(opened.isError, opened.text).toBe(false);
      expect(opened.text).toMatch(new RegExp(`^Test "counts to one" \\(tests/counter\\.e2e\\.ts:${PASSING}\\) passed after \\S+; 3 steps ran\\.\n`));
      expect(opened.text).toContain('The session is on the screen the test ended on, shown below. Its afterEach hooks and fixture teardown run at close_session.\n\nSession ');
      // The screen is the test's last, not the app URL opened afresh.
      expect(opened.text).toContain('status "Counter" text="1"');
      expect(await observe()).toContain('status "Counter" text="1"');
      expect(existsSync(marker)).toBe(false);
      const closed = await invoke('close_session');
      expect(closed.text).toMatch(/^Session \S+ closed/);
      expect(readFileSync(marker, 'utf8')).toBe('ran');
    });

    it('opens a failing test with its code, line, code frame, and nearest nodes, on the screen it failed on', async () => {
      const opened = await invoke('open_session', { test: `tests/counter.e2e.ts:${FAILING}` });
      expect(opened.isError, opened.text).toBe(false);
      const lines = opened.text.split('\n');
      expect(lines[0]).toMatch(new RegExp(`^Test "taps a button that is not there" \\(tests/counter\\.e2e\\.ts:${FAILING}\\) failed after \\S+; 3 steps ran\\.$`));
      expect(lines[1]).toMatch(/^LOCATOR_NOT_FOUND: .*getByRole\("button", name: "Incremnt"\)/);
      expect(lines[2]).toMatch(new RegExp(`^At tests/counter\\.e2e\\.ts:${MISSING_TAP}:\\d+$`));
      expect(opened.text).toContain(`\n  ${String(MISSING_TAP).padStart(3)}|   await screen.getByRole('button', { name: missing }).tap();\n`);
      expect(opened.text).toMatch(/\nOn screen, closest to what the locator asked for:\n {2}#n\d+ button "Increment".*\n/);
      expect(opened.text).toContain(`\n  3. ✗ locator.tap getByRole("button", name: "Incremnt") LOCATOR_NOT_FOUND (tests/counter.e2e.ts:${MISSING_TAP})\n`);
      expect(opened.text).toContain(`To run the fixed test from the start, close_session, then open_session {test: "tests/counter.e2e.ts:${FAILING}"}.`);
      expect(opened.text).toContain('status "Counter" text="1"');
      expect(await observe()).toContain('status "Counter" text="1"');
      // The session goes on as a session from the failure.
      const located = await invoke('call', { tool: 'locate', args: { role: 'button', name: 'Increment' } });
      expect(located.text).toContain('1 node matches');
      await invoke('close_session');
    });

    it('runs the test files as they are now when the session opens again', async () => {
      writeFileSync(path.join(project.dir, 'tests/label.ts'), `export const missing = 'Increment';\n`);
      const fixed = await invoke('open_session', { test: `tests/counter.e2e.ts:${FAILING}` });
      expect(fixed.isError, fixed.text).toBe(false);
      expect(fixed.text).toMatch(/^Test "taps a button that is not there" \(tests\/counter\.e2e\.ts:\d+\) passed/);
      expect(fixed.text).toContain('status "Counter" text="2"');
      // Test lines carry on from the test, by the ids on the screen it opened with; the test's own steps print none.
      const increment = /#(n\d+) button "Increment"/.exec(fixed.text)?.[1];
      const tapped = await invoke('call', { tool: 'tap', args: { target: increment } });
      expect(tapped.text.split('\n')[1], tapped.text).toBe('Test line: await screen.getByRole("button", "Increment").tap();');
      // So do the statements run_code passes there.
      const ran = await invoke('call', { tool: 'run_code', args: { code: "await expect(screen.getByRole('status', 'Counter')).toHaveText('3');" } });
      expect(ran.isError, ran.text).toBe(false);
      const drafted = await invoke('call', { tool: 'test_lines' });
      expect(drafted.text).toContain(
        `after test tests/counter.e2e.ts:${FAILING} stopped, in order (2 lines):\n\nawait screen.getByRole("button", "Increment").tap();\nawait expect(screen.getByRole('status', 'Counter')).toHaveText('3');\n\nPut them in that test where it stopped`,
      );
      await invoke('close_session');
    });

    it('fails a test on a promise it left rejected, and keeps serving', async () => {
      const forgot = await invoke('open_session', { test: `tests/sloppy.e2e.ts:${lineOf(SLOPPY, "test('forgets an await'")}` });
      expect(forgot.isError, forgot.text).toBe(false);
      expect(forgot.text).toMatch(/^Test "forgets an await" \(tests\/sloppy\.e2e\.ts:\d+\) failed after \S+; \d+ steps? ran\.\nERROR: seed endpoint returned 500\n/);
      await invoke('close_session');

      // One that rejects after the body ended is the test's too, reported at close.
      const left = await invoke('open_session', { test: `tests/sloppy.e2e.ts:${lineOf(SLOPPY, "test('leaves a promise behind'")}` });
      expect(left.text).toMatch(/^Test "leaves a promise behind" \(tests\/sloppy\.e2e\.ts:\d+\) passed/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const closed = await invoke('close_session');
      expect(closed.text).toContain('Cleanup: UNHANDLED_REJECTION: a promise rejected after the test\'s body ended, most likely left by "leaves a promise behind": late failure');

      // One that rejects once its session closed is a warning for the operator, not a crash.
      const early = await invoke('open_session', { test: `tests/sloppy.e2e.ts:${lineOf(SLOPPY, "test('leaves a promise for after the close'")}` });
      expect(early.text).toMatch(/^Test "leaves a promise for after the close" .* passed/);
      await invoke('close_session');
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(stderr).toContain('e2e mcp: [warning] a promise rejected after its session closed, most likely left by test "leaves a promise for after the close": later failure');

      const after = await invoke('open_session', { test: `tests/counter.e2e.ts:${PASSING}` });
      expect(after.text).toMatch(/^Test "counts to one" .* passed/);
      await invoke('close_session');
    });

    it('keeps a body its timeout cut short from driving the session', async () => {
      const opened = await invoke('open_session', { test: `tests/sloppy.e2e.ts:${lineOf(SLOPPY, "test('outlives its timeout'")}` });
      expect(opened.text).toMatch(/^Test "outlives its timeout" .* timed out after \S+; 1 step ran\.\nTEST_TIMEOUT: test timed out after 1000 ms in phase body\n/);
      expect(opened.text).not.toContain("app.open('/about')");
      expect(opened.text).toContain('heading "Home"');
      // Past the time the body's last line would have run: it ran out of budget and opened nothing.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const observed = await observe();
      expect(observed).toContain('heading "Home"');
      expect(observed).not.toContain('document "About page"');
      await invoke('close_session');
    });

    it('reports a beforeAll failure as the outcome, once', async () => {
      const opened = await invoke('open_session', { test: 'tests/hooks.e2e.ts' });
      expect(opened.text).toMatch(/^Test "needs the database" \(tests\/hooks\.e2e\.ts:\d+\) failed after \S+; 0 steps ran\.\nHOOK_FAILED in beforeAll: beforeAll failed: database is down\n/);
      // The test never opened the app, and the session still opens.
      expect(opened.text).toMatch(/\n\nNo screen to show: no app page is open/);
      const closed = await invoke('close_session');
      expect(closed.text).not.toContain('HOOK_FAILED');
    });

    it('compares a screenshot against the baseline an earlier session wrote', async () => {
      const first = await invoke('open_session', { test: 'tests/visual.e2e.ts' });
      expect(first.text).toMatch(/^Test "matches its screenshot" \(tests\/visual\.e2e\.ts:\d+\) failed/);
      expect(first.text).toContain('no stored screenshot');
      await invoke('close_session');
      const second = await invoke('open_session', { test: 'tests/visual.e2e.ts' });
      expect(second.text).toMatch(/^Test "matches its screenshot" \(tests\/visual\.e2e\.ts:\d+\) passed/);
      await invoke('close_session');
    });

    it('refuses a name that selects no test, several, or one a session cannot run alone, before anything boots', async () => {
      const refused = async (test: string): Promise<string> => {
        const result = await invoke('open_session', { test });
        expect(result.isError, test).toBe(true);
        return result.text;
      };
      const none = await refused('nothing-here');
      expect(none).toMatch(/^NO_TESTS: no test file matched nothing-here; .*; name a test file the config finds, alone when it holds one test, or with :line on the line its test\( call is on, not a line inside the test$/);
      expect(await refused('tests/others.e2e.ts:99')).toContain('tests/others.e2e.ts:99 names no test (declared at lines 3, 7, 12, 17)');
      expect(await refused('others')).toBe(
        'TEST_AMBIGUOUS: "others" selects 4 tests on target "web", and a session runs one; name it as file:line: tests/others.e2e.ts:3 "first", tests/others.e2e.ts:7 "second", tests/others.e2e.ts:12 "flow › step one", tests/others.e2e.ts:17 "signed in"',
      );
      expect(await refused('tests/others.e2e.ts:12')).toMatch(/^SESSION_TEST_UNSUPPORTED: test "flow › step one" \(tests\/others\.e2e\.ts:12\) is in a serial group/);
      expect(await refused('tests/others.e2e.ts:17')).toMatch(/^SESSION_TEST_UNSUPPORTED: test "signed in" \(tests\/others\.e2e\.ts:17\) starts from session "member"/);
      expect((await invoke('close_session')).text).toBe('No session is open.');
    });
  });

  /** An in-process host whose sessions load `config` on the fixture app, as the project's config file would. */
  const inProcessHost = (project: FixtureProject, config: Omit<E2EConfig, 'targets'> = {}) =>
    new SessionHost({
      locateConfig: () => path.join(project.dir, 'e2e.config.ts'),
      loadConfig: async (configPath) => ({
        ...resolveConfig({ ...config, targets: [webTarget('web', app.url)] } as E2EConfig as never, { projectRoot: project.dir, env: {}, configPath }),
        configPath,
      }),
      env: {},
      headed: false,
      log: () => undefined,
    });

  describe('the replay cache', () => {
    const counter = FLOWS.find((flow) => flow.title === 'increments the counter')!;
    let project: FixtureProject;

    beforeAll(() => {
      project = createProject({ 'tests/flows.e2e.ts': flowsSuite([counter], 'record') });
    });

    afterAll(() => {
      project?.cleanup();
    });

    it("records a session's agent steps for the next session and for e2e run", async () => {
      const config = cacheConfig(flowsModel([counter]));
      const sessions = inProcessHost(project, config);
      const before = loopCalls.length;
      expect(await sessions.open({ test: 'tests/flows.e2e.ts' })).toMatch(/^Test "increments the counter" \(tests\/flows\.e2e\.ts:\d+\) passed/);
      await sessions.close('done');
      const modelCalls = loopCalls.length;
      expect(modelCalls).toBeGreaterThan(before);
      // Its agent steps read the test's title, as a run's do.
      expect(loopCalls[before]!.prompt).toContain('Test: increments the counter');
      expect(entriesFor(project, counter.title)).toHaveLength(1);

      // The next session replays what the first recorded, with no model call.
      expect(await sessions.open({ test: 'tests/flows.e2e.ts' })).toMatch(/^Test "increments the counter" \(tests\/flows\.e2e\.ts:\d+\) passed/);
      await sessions.close('done');
      expect(loopCalls).toHaveLength(modelCalls);

      // And so does e2e run: the key is the run's.
      const run = await runExisting(project, { appUrl: app.url, config });
      expect(run.exitCode).toBe(0);
      expectReplayed(onlyActStep(run, counter.title), counter.actions[0]!);
      expect(loopCalls).toHaveLength(modelCalls);
    });
  });

  describe('sessions side by side', () => {
    // Each body polls for a while, so two bodies overlap unless they take turns.
    const polling = (title: string, preamble = '') => `import { expect, test } from 'e2e';
${preamble}
test(${JSON.stringify(title)}, async ({ app }) => {
  await app.open('/');
  await expect.poll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return 1;
  }).toBe(1);
});
`;
    let project: FixtureProject;

    beforeAll(() => {
      project = createProject({
        // A top-level await yields collection's slot halfway through the file.
        'tests/slow-load.e2e.ts': polling('loads slowly', 'await new Promise((resolve) => setTimeout(resolve, 300));'),
        'tests/quick-load.e2e.ts': polling('loads quickly'),
        // Holds its turn until the case releases it, through the process both share.
        'tests/held.e2e.ts': `import { test } from 'e2e';

test('holds its turn', async ({ app }) => {
  await app.open('/');
  const shared = globalThis as unknown as { f1Held: () => void; f1Gate: Promise<void> };
  shared.f1Held();
  await shared.f1Gate;
});
`,
        'tests/marked.e2e.ts': `import { writeFileSync } from 'node:fs';
import { beforeAll, test } from 'e2e';

beforeAll(() => {
  writeFileSync(new URL('../marked.txt', import.meta.url), 'ran');
});

test('marks', async ({ app }) => {
  await app.open('/');
});
`,
      });
    });

    afterAll(() => {
      project?.cleanup();
    });

    it('runs none of a test whose open was cancelled while it waited for its turn', async () => {
      const sessions = inProcessHost(project);
      const shared = globalThis as unknown as { f1Held: () => void; f1Gate: Promise<void> };
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        shared.f1Held = resolve;
      });
      shared.f1Gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = sessions.open({ test: 'tests/held.e2e.ts' });
      await held;
      const cancel = new AbortController();
      const waiting = sessions.open({ test: 'tests/marked.e2e.ts' }, cancel.signal);
      // Long enough for the second session to boot and queue behind the first.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      cancel.abort();
      await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
      release();
      expect(await holding).toMatch(/^Test "holds its turn" \(tests\/held\.e2e\.ts:\d+\) passed/);
      await sessions.closeAll('done');
      expect(existsSync(path.join(project.dir, 'marked.txt'))).toBe(false);
    });

    it('collect and run their tests one at a time, and both pass', async () => {
      const sessions = inProcessHost(project);
      const opened = await Promise.all([sessions.open({ test: 'tests/slow-load.e2e.ts' }), sessions.open({ test: 'tests/quick-load.e2e.ts' })]);
      expect(opened[0]).toMatch(/^Test "loads slowly" \(tests\/slow-load\.e2e\.ts:\d+\) passed/);
      expect(opened[1]).toMatch(/^Test "loads quickly" \(tests\/quick-load\.e2e\.ts:\d+\) passed/);
      await sessions.closeAll('done');
    });
  });
});
