/**
 * `e2e mcp` end to end: the built CLI serving a fixture project over stdio to
 * a real MCP client. Covers the project tools, a live session driven through
 * the grammar tools, the secret and pixel invariants, a second session after
 * the first closed, and stdout hygiene: a config that prints to stdout must
 * not corrupt the protocol.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const CONFIG = `import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

// Anything a config prints must reach stderr, never the protocol stream.
console.log('config loaded');

export default {
  targets: [{ name: 'web', platform: 'web', engine: playwright({ url: process.env.APP_URL! }) }],
  credentials: { admin: { username: 'admin', password: 'admin-pass' } },
  workers: 1,
} satisfies E2EConfig;
`;

const PASSING = `import { test, expect } from '@e2edev/e2e';

test('increments the counter', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

const FAILING = `import { test, expect } from '@e2edev/e2e';

test('expects a count that never comes', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('status')).toHaveText('2', { timeout: 500 });
});
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly images: number;
}

describe('e2e mcp', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return {
      text: result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
      isError: result.isError === true,
      images: result.content.filter((part) => part.type === 'image').length,
    };
  };

  /** The node id of the first observation line matching `pattern`. */
  const nodeId = (text: string, pattern: RegExp): string => {
    const line = text.split('\n').find((candidate) => pattern.test(candidate));
    const match = line === undefined ? null : /#(n\d+)/.exec(line);
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'e2e.config.ts': CONFIG,
      'tests/counter.e2e.ts': PASSING,
      'tests/failing.e2e.ts': FAILING,
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--headless'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: 'e2e-mcp-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('lists the project tools, the grammar the engine honors, and the guide resources', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      'list_tests',
      'run_tests',
      'read_report',
      'open_session',
      'observe',
      'tap',
      'type',
      'press',
      'select',
      'scroll',
      'navigate',
      'type_secret',
      'locate',
      'screenshot',
      'close_session',
    ]);
    const tap = tools.find((tool) => tool.name === 'tap')!;
    expect(tap.description).toBe('Tap or click one node.');
    expect(tap.inputSchema).toMatchObject({ type: 'object', required: ['target'] });
    expect(tools.find((tool) => tool.name === 'observe')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'type_secret')?.description).toContain('"admin" (password)');

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['e2e://guide', 'e2e://report/latest', 'e2e://guide/mcp', 'e2e://guide/writing-tests']),
    );
    const guide = await client.readResource({ uri: 'e2e://guide/mcp' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Driving the app over MCP');
  });

  it('lists the tests per file with their dispositions', async () => {
    const result = await call('list_tests');
    expect(result.isError).toBe(false);
    expect(result.text).toContain('2 test-target pairs in 2 files; 2 would run, 0 are skipped.');
    expect(result.text).toContain('## tests/counter.e2e.ts');
    expect(result.text).toContain('- increments the counter [web]');
    const narrowed = await call('list_tests', { files: ['tests/failing.e2e.ts'] });
    expect(narrowed.text).not.toContain('increments the counter');
    expect(narrowed.text).toContain('- expects a count that never comes [web]');
    const none = await call('list_tests', { files: ['tests/nope.e2e.ts'] });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('NO_TESTS');
    expect(none.text).toContain('tests/nope.e2e.ts');
  });

  it('refuses session tools before a session is open', async () => {
    const result = await call('observe');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('NO_SESSION');
  });

  it('opens a session, locates, acts, fills a secret, and withholds pixels afterwards', async () => {
    const opened = await call('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain('open on target "web" (platform web, engine playwright');
    expect(opened.text).toContain(`App: ${app.url}/`);
    expect(opened.text).toContain('Credentials: "admin" (username "admin")');
    expect(opened.text).toMatch(/Current screen \(revision b\d+\) at \/:/);
    expect(opened.text).toContain('button "Increment"');

    const unique = await call('locate', { role: 'button', name: 'Increment' });
    expect(unique.text).toContain('1 node matches');
    expect(unique.text).toContain('Use: screen.getByRole("button", { name: "Increment" })');
    const ambiguous = await call('locate', { text: 'Duplicated' });
    expect(ambiguous.text).toContain('2 nodes match');
    expect(ambiguous.text).toContain('LOCATOR_AMBIGUOUS');
    const missing = await call('locate', { label: 'Nowhere' });
    expect(missing.text).toContain('0 nodes match');
    expect(missing.text).toContain('LOCATOR_NOT_FOUND');

    const observed = await call('observe');
    const tapped = await call('tap', { target: nodeId(observed.text, /button "Increment"/) });
    expect(tapped.isError, tapped.text).toBe(false);
    expect(tapped.text).toMatch(/^Tapped #n\d+\.\n\nUpdated screen/);
    expect(tapped.text).toMatch(/status "Counter" text="1"/);

    const stale = await call('tap', { target: 'n9999' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('LOCATOR_NOT_FOUND');

    const before = await call('screenshot');
    expect(before.isError, before.text).toBe(false);
    expect(before.images).toBe(1);

    const filled = await call('type_secret', { target: nodeId(tapped.text, /textbox "Password"/), name: 'admin' });
    expect(filled.isError, filled.text).toBe(false);
    expect(filled.text).toContain('Filled secret "admin"');
    expect(filled.text).not.toContain('admin-pass');

    const after = await call('screenshot');
    expect(after.images).toBe(0);
    expect(after.text).toContain('Screenshot withheld: PIXEL_TAINTED');

    const denied = await call('navigate', { url: 'https://example.com/' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('POLICY_DENIED');

    const again = await call('open_session');
    expect(again.isError).toBe(true);
    expect(again.text).toContain('SESSION_OPEN');

    const closed = await call('close_session');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).toMatch(/^Session \S+ closed \(closed by the agent\); \d+ tool calls ran\./);
    expect(closed.text).not.toContain('Cleanup:');

    const gone = await call('observe');
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('the previous session ended: closed by the agent');
  });

  it('opens a second session after the first closed, and run_tests closes it', async () => {
    const reopened = await call('open_session', { target: 'web' });
    expect(reopened.isError, reopened.text).toBe(false);
    expect(reopened.text).toContain('button "Increment"');

    const run = await call('run_tests', { files: ['tests/counter.e2e.ts'] });
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toContain('# Run passed (exit 0)');
    expect(run.text).toContain('1 executed, 1 passed, 0 failed');
    expect(run.text).toContain(`Report: ${path.join(project.dir, '.e2e', 'report.json')}`);

    const afterRun = await call('observe');
    expect(afterRun.isError).toBe(true);
    expect(afterRun.text).toContain('run_tests started');
  });

  it('digests a failing run and reads the same digest back from disk', async () => {
    const run = await call('run_tests', { files: ['tests/failing.e2e.ts'], retries: 0 });
    expect(run.isError).toBe(false);
    expect(run.text).toContain('# Run failed (exit 1)');
    expect(run.text).toContain('### expects a count that never comes');
    expect(run.text).toContain('- File: tests/failing.e2e.ts:');
    expect(run.text).toContain('ASSERTION_FAILED');
    expect(run.text).toContain('- Failing step: expect.toHaveText');

    const report = await call('read_report');
    expect(report.text).toContain('# Run failed (exit 1)');
    expect(report.text).toContain('ASSERTION_FAILED');
    const resource = await client.readResource({ uri: 'e2e://report/latest' });
    expect((resource.contents[0] as { text: string }).text).toContain('ASSERTION_FAILED');
  });

  it('kept stdout for the protocol: the config\'s console.log landed on stderr', () => {
    expect(stderr).toContain('config loaded');
    expect(stderr).toContain('e2e mcp: [info] e2e mcp');
  });
});
