/**
 * Test lines end to end: the built `e2e mcp` server on a fixture page, driven
 * by a real MCP client. Every action answers with the line that repeats it,
 * a password by its credential and never its value, a button repeated per
 * row scoped under its row, twins in plain divs by their order, a shadow
 * root's twin by the box it never left, and an icon button by its test id;
 * `test_lines` returns them in order. Pasted into a test file, that draft passes a run.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const USERNAME = 'ada@example.test';
const PASSWORD = 'lines-Pa55-9Kq';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  credentials: { admin: { username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} } },
} satisfies E2EConfig;
`;

describe('e2e mcp test lines', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let replay: FixtureProject | undefined;
  let client: Client;

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const result = (await client.callTool({ name: 'call', arguments: { tool, args } }, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
  };

  const nodeId = (text: string, pattern: RegExp): string => {
    const match = /#(n\d+)/.exec(text.split('\n').find((line) => pattern.test(line)) ?? '');
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'e2e-mcp-test-lines', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    replay?.cleanup();
    await app?.close();
  });

  it('answers each action with its test line, and the drafted lines pass a run', async () => {
    const opened = await client.callTool({ name: 'open_session', arguments: {} });
    expect(opened.isError).not.toBe(true);

    const navigated = await call('navigate', { url: `${app.url}/test-lines` });
    expect(navigated.text.split('\n').slice(0, 2)).toEqual([`Navigated to ${app.url}/test-lines.`, 'Test line: await app.open("/test-lines");']);
    const screen = (await call('observe')).text;

    const steps: [string, Record<string, unknown>, string][] = [
      ['type', { target: nodeId(screen, /textbox "Username"/), value: USERNAME }, 'await screen.getByRole("textbox", "Username").fill(credentials.user("admin").username);'],
      ['type_secret', { target: nodeId(screen, /textbox "Password"/), name: 'admin.password' }, 'await screen.getByRole("textbox", "Password").fill(credentials.user("admin").password);'],
      ['select', { target: nodeId(screen, /combobox "Plan"/), value: 'Pro' }, 'await screen.getByRole("combobox", "Plan").selectOption("Pro");'],
      ['check', { target: nodeId(screen, /checkbox "Accept terms"/) }, 'await screen.getByRole("checkbox", "Accept terms").check();'],
      [
        'tap',
        { target: nodeId(screen.slice(screen.indexOf('Offer B')), /button "Reserve"/) },
        'await screen.getByRole("listitem").filter({ hasText: "Offer B" }).getByRole("button", "Reserve").tap();',
      ],
      [
        'tap',
        { target: nodeId(screen, /button "Keep"/) },
        'await screen.getByRole("button", "Keep").nth(1).tap(); // 2 of 2 matches, by position; a unique name or test id holds up better',
      ],
      [
        'tap',
        { target: nodeId(screen.slice(screen.indexOf('Row two')), /button "Pick"/) },
        'await screen.getByRole("button", "Pick").nth(1).tap(); // 2 of 2 matches, by position; a unique name or test id holds up better',
      ],
      ['tap', { target: nodeId(screen, /button testid="star"/) }, 'await screen.getByTestId("star").tap();'],
      ['tap', { target: nodeId(screen, /button "Sign in"/) }, 'await screen.getByRole("button", "Sign in").tap();'],
    ];
    for (const [tool, args, line] of steps) {
      const result = await call(tool, args);
      expect(result.isError, result.text).toBe(false);
      expect(result.text.split('\n')[1], tool).toBe(`Test line: ${line}`);
      expect(result.text).not.toContain(PASSWORD);
    }
    expect((await call('observe')).text).toContain('status "Summary" text="user=ada@example.test password=set plan=Pro terms=true offer=B kept=shadow picked=2 starred=true"');

    const drafted = await call('test_lines');
    expect(drafted.isError).toBe(false);
    expect(drafted.text).not.toContain(PASSWORD);
    expect(drafted.text).toContain("Import credentials from 'e2e'.");
    const body = drafted.text.split('\n').filter((line) => line.startsWith('await ') || line.startsWith('// '));
    expect(body).toEqual(['await app.open();', 'await app.open("/test-lines");', ...steps.map(([, , line]) => line)]);
    await client.callTool({ name: 'close_session', arguments: {} });

    // The real proof: the draft, pasted as is, replays the flow in a run.
    const run = await runProject(
      {
        'tests/draft.e2e.ts': [
          "import { test, expect, credentials } from 'e2e';",
          '',
          "test('replays the drafted lines', async ({ app, screen }) => {",
          ...body.map((line) => `  ${line}`),
          "  await expect(screen.getByRole('status', 'Summary')).toHaveText('user=ada@example.test password=set plan=Pro terms=true offer=B kept=shadow picked=2 starred=true');",
          '});',
          '',
        ].join('\n'),
      },
      { appUrl: app.url, config: { credentials: { admin: { username: USERNAME, password: PASSWORD } } } },
    );
    replay = run.project;
    const result = resultByTitle(run.outcome, 'replays the drafted lines');
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
  });
});
