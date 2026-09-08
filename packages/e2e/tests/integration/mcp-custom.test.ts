/**
 * `e2e mcp` with a project that has two targets, a custom engine with fewer
 * verbs, and project tools from `createAgent({ tools })`: the tool list is the
 * union over targets, a project tool named like a built-in is skipped, tools
 * scoped to a platform no target has are not offered, and each live session
 * refuses what its own target cannot honor.
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
import { createAgent, defineTool, getToolContext } from '@e2edev/e2e/agent';
import { playwright } from '@e2edev/playwright';
import { z } from 'zod';
import { createFakeEngine } from '../../helpers/fake-engine.ts';

const kiosk = createFakeEngine({
  tree: { ref: { id: 'root', revision: '' }, role: 'root', children: [
    { ref: { id: 'k-1', revision: '' }, role: 'button', name: 'Start order', states: { hidden: false } },
    { ref: { id: 'k-2', revision: '' }, role: 'textbox', name: 'Table', states: { hidden: false } },
  ] },
});

export default {
  targets: [
    { name: 'web', platform: 'web', engine: playwright({ url: process.env.APP_URL! }) },
    { name: 'kiosk', platform: 'kiosk', engine: kiosk.engine },
  ],
  agents: { default: createAgent({
    tools: {
      seed_data: defineTool(
        { description: 'Seed a tenant with demo data.', inputSchema: z.object({ tenant: z.string() }), execute: async ({ tenant }: { tenant: string }) => \`Seeded \${tenant}.\` },
        { mutates: true },
      ),
      count_nodes: defineTool(
        { description: 'Count the nodes on screen.', inputSchema: z.object({}), execute: async (_input: unknown, options: object) => \`\${(await getToolContext(options).observe()).text.split('\\\\n').length} nodes\` },
        { mutates: false },
      ),
      screenshot: defineTool(
        { description: 'A project tool that collides with a built-in.', inputSchema: z.object({}), execute: async () => 'never served' },
        { mutates: false },
      ),
      shake: defineTool(
        { description: 'Shake the phone.', inputSchema: z.object({}), execute: async () => 'shaken' },
        { mutates: true, platforms: ['ios'] },
      ),
      kiosk_reset: defineTool(
        { description: 'Reset the kiosk.', inputSchema: z.object({}), execute: async () => 'kiosk reset' },
        { mutates: true, platforms: ['kiosk'] },
      ),
    },
  }) },
} satisfies E2EConfig;
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

describe('e2e mcp with project tools and a custom engine', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
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
    project = createProject({ 'e2e.config.ts': CONFIG });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--headless'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: 'e2e-mcp-custom-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('registers the union of verbs and project tools, once each, and skips the colliding name', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names.filter((name) => name === 'screenshot')).toHaveLength(1);
    expect(tools.find((tool) => tool.name === 'screenshot')?.description).toContain('masked pixels');
    expect(names).toEqual(expect.arrayContaining(['seed_data', 'count_nodes', 'kiosk_reset', 'scroll', 'navigate', 'tap']));
    expect(names).not.toContain('shake');
    expect(tools.find((tool) => tool.name === 'seed_data')?.annotations).toMatchObject({ readOnlyHint: false });
    expect(tools.find((tool) => tool.name === 'count_nodes')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(stderr).toContain('project tool "screenshot" is not served over MCP');
  });

  it('needs a target name when the config declares several', async () => {
    const result = await call('open_session');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('TARGET_REQUIRED');
    expect(result.text).toContain('web, kiosk');
  });

  it('runs project tools in a web session and refuses the kiosk-only one', async () => {
    const opened = await call('open_session', { target: 'web' });
    expect(opened.isError, opened.text).toBe(false);
    const toolsLine = opened.text.split('\n').find((line) => line.startsWith('Tools: '))!;
    expect(toolsLine).toContain('seed_data, count_nodes');
    expect(toolsLine).not.toContain('kiosk_reset');
    expect(toolsLine.match(/screenshot/g)).toHaveLength(1);

    const seeded = await call('seed_data', { tenant: 'acme' });
    expect(seeded.isError, seeded.text).toBe(false);
    expect(seeded.text).toBe('Seeded acme.');
    const counted = await call('count_nodes');
    expect(counted.isError, counted.text).toBe(false);
    expect(counted.text).toMatch(/^\d+ nodes$/);

    const foreign = await call('kiosk_reset');
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('UNSUPPORTED_CAPABILITY');

    const closed = await call('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });

  it('drives a custom engine with the verbs it declares and nothing more', async () => {
    const opened = await call('open_session', { target: 'kiosk' });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain('platform kiosk, engine fake');
    expect(opened.text).toContain('button "Start order"');
    const toolsLine = opened.text.split('\n').find((line) => line.startsWith('Tools: '))!;
    expect(toolsLine).toContain('kiosk_reset');
    expect(toolsLine).not.toContain('scroll');

    const observed = await call('observe');
    const id = /#(\S+) button "Start order"/.exec(observed.text)?.[1];
    expect(id).toBeDefined();
    const tapped = await call('tap', { target: id! });
    expect(tapped.isError, tapped.text).toBe(false);
    expect(tapped.text).toContain(`Tapped #${id}.`);
    expect(tapped.text).toMatch(/Screen changes since revision|The screen did not change/);

    // The fake declares no viewport swipe, so scroll is a verb this target lacks.
    const scrolled = await call('scroll', { direction: 'down' });
    expect(scrolled.isError).toBe(true);
    expect(scrolled.text).toContain('UNSUPPORTED_CAPABILITY');

    const reset = await call('kiosk_reset');
    expect(reset.isError, reset.text).toBe(false);
    expect(reset.text).toBe('kiosk reset');

    const closed = await call('close_session');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).not.toContain('Cleanup:');
  });
});
