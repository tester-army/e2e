/**
 * `e2e mcp` end to end: the built CLI serving a fixture project over stdio to
 * a real MCP client. Covers a live session driven through the grammar
 * tools, the secret and pixel invariants, a second session after the first
 * closed, and stdout hygiene: a config that prints to stdout must not
 * corrupt the protocol.
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
} satisfies E2EConfig;
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
    project = createProject({ 'e2e.config.ts': CONFIG });
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

  it('lists the grammar the engine honors and the guide resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
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
    expect(tap.description).toContain('Tap or click one node.');
    expect(tap.inputSchema).toMatchObject({ type: 'object', required: ['target'] });
    expect(tools.find((tool) => tool.name === 'observe')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'type_secret')?.description).toContain('"admin" (password)');

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['e2e://guide', 'e2e://guide/mcp', 'e2e://guide/writing-tests']),
    );
    const guide = await client.readResource({ uri: 'e2e://guide/mcp' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Driving the app over MCP');
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
    expect(opened.text).toMatch(/Current screen \(revision b\d+, path \/, \d+ nodes\):/);
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
    // An action reports what changed on screen, as it does for the testing agent.
    expect(tapped.text).toMatch(/^Tapped #n\d+\.\n\nScreen changes since revision/);
    const after = await call('observe');
    expect(after.text).toMatch(/status "Counter" text="1"/);

    // A stale id is refused the way the testing agent sees it: the action
    // reports its failure and the screen it re-observed, no wrong node acted on.
    const stale = await call('tap', { target: 'n9999' });
    expect(stale.text).toMatch(/^Tapped #n9999\. failed: .*n9999/);
    expect(stale.text).toContain('re-observe');

    const before = await call('screenshot');
    expect(before.isError, before.text).toBe(false);
    expect(before.images).toBe(1);

    const filled = await call('type_secret', { target: nodeId(after.text, /textbox "Password"/), name: 'admin' });
    expect(filled.isError, filled.text).toBe(false);
    expect(filled.text).toContain('Filled secret "admin"');
    expect(filled.text).not.toContain('admin-pass');

    const tainted = await call('screenshot');
    expect(tainted.images).toBe(0);
    expect(tainted.text).toContain('Screenshot withheld: PIXEL_TAINTED');

    const denied = await call('navigate', { url: 'https://example.com/' });
    expect(denied.text).toMatch(/^Navigated to https:\/\/example\.com\/\. failed: /);
    expect(denied.text).toContain('is not in allowedOrigins');

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

  it('opens a second session after the first closed, and names an unknown target', async () => {
    const unknown = await call('open_session', { target: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('UNKNOWN_TARGET');

    const reopened = await call('open_session', { target: 'web' });
    expect(reopened.isError, reopened.text).toBe(false);
    expect(reopened.text).toContain('button "Increment"');
    const closed = await call('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });

  it('kept stdout for the protocol: the config\'s console.log landed on stderr', () => {
    expect(stderr).toContain('config loaded');
    expect(stderr).toContain('e2e mcp: [info] e2e mcp');
  });
});
