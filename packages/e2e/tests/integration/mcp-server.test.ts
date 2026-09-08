/**
 * `e2e mcp` end to end: the built CLI serving a fixture project over stdio to
 * a real MCP client. Covers the project tools, the guide resources, and
 * stdout hygiene: a config that prints to stdout must not corrupt the
 * protocol.
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
    };
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
      args: [CLI, 'mcp'],
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

  it('lists the project tools and the guide resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['list_tests', 'run_tests', 'read_report']);
    expect(tools.find((tool) => tool.name === 'list_tests')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'run_tests')?.inputSchema).toMatchObject({ type: 'object' });

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['e2e://guide', 'e2e://report/latest', 'e2e://guide/mcp', 'e2e://guide/writing-tests']),
    );
    const guide = await client.readResource({ uri: 'e2e://guide/mcp' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Working through the MCP server');
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

  it('reports a missing report as an error the agent can act on', async () => {
    const result = await call('read_report');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('REPORT_NOT_FOUND');
    expect(result.text).toContain('run_tests');
  });

  it('runs a passing selection and digests it', async () => {
    const run = await call('run_tests', { files: ['tests/counter.e2e.ts'] });
    expect(run.isError, run.text).toBe(false);
    expect(run.text).toContain('# Run passed (exit 0)');
    expect(run.text).toContain('1 executed, 1 passed, 0 failed');
    expect(run.text).toContain(`Report: ${path.join(project.dir, '.e2e', 'report.json')}`);
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
