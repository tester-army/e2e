/**
 * `e2e mcp` with a project that has two targets, a custom engine with fewer
 * verbs, and project tools from `agents.default.tools`: the server's tool
 * list stays the same four, each session's catalog is what its own target
 * can do (the engine's verbs, the project tools for its platform), and a
 * second config in the same project opens without restarting the server. A
 * project tool named like a built-in never gets here: config load refuses it.
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

const KIOSK = `import { createFakeEngine } from '../../helpers/fake-engine.ts';

export const kiosk = createFakeEngine({
  tree: { ref: { id: 'root', revision: '' }, role: 'root', children: [
    { ref: { id: 'k-1', revision: '' }, role: 'button', name: 'Start order', states: { hidden: false } },
    { ref: { id: 'k-2', revision: '' }, role: 'textbox', name: 'Table', states: { hidden: false } },
  ] },
});
`;

const CONFIG = `import type { E2EConfig } from 'e2e';
import { defineTool, getToolContext } from 'e2e/agent';
import { web } from '@e2e-dev/web';
import { z } from 'zod';
import { kiosk } from './kiosk.ts';

export default {
  targets: [
    { name: 'web', platform: 'web', engine: web({ url: process.env.APP_URL! }) },
    { name: 'kiosk', platform: 'kiosk', engine: kiosk.engine },
  ],
  agents: { default: {
    tools: {
      seed_data: defineTool(
        { description: 'Seed a tenant with demo data.', inputSchema: z.object({ tenant: z.string() }), execute: async ({ tenant }: { tenant: string }) => \`Seeded \${tenant}.\` },
        { mutates: true },
      ),
      count_nodes: defineTool(
        { description: 'Count the nodes on screen.', inputSchema: z.object({}), execute: async (_input: unknown, options: object) => \`\${(await getToolContext(options).observe()).text.split('\\\\n').length} nodes\` },
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
  } },
} satisfies E2EConfig;
`;

/** A second project config beside the first: one target, no project tools. */
const KIOSK_ONLY_CONFIG = `import type { E2EConfig } from 'e2e';
import { kiosk } from './kiosk.ts';

export default {
  targets: [{ name: 'kiosk-only', platform: 'kiosk', engine: kiosk.engine }],
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

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return {
      text: result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
      isError: result.isError === true,
    };
  };
  const call = (tool: string, args?: Record<string, unknown>): Promise<ToolText> => invoke('call', { tool, ...(args === undefined ? {} : { args }) });
  const catalogNames = (text: string): string[] =>
    text
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => /^- (\S+?)(?: \{|:)/.exec(line)![1]!);

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG, 'kiosk.ts': KIOSK, 'kiosk.config.ts': KIOSK_ONLY_CONFIG });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--headless'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
      stderr: 'ignore',
    });
    client = new Client({ name: 'e2e-mcp-custom-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('serves the same four tools whatever the project declares', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['open_session', 'tools', 'call', 'close_session']);
  });

  it('needs a target name when the config declares several', async () => {
    const result = await invoke('open_session');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('TARGET_REQUIRED');
    expect(result.text).toContain('web, kiosk');
  });

  it('catalogs the project tools of a web session, runs them, and skips the foreign ones', async () => {
    const opened = await invoke('open_session', { target: 'web' });
    expect(opened.isError, opened.text).toBe(false);
    expect(catalogNames(opened.text)).toEqual([
      'observe',
      'tap',
      'double_tap',
      'long_press',
      'right_click',
      'hover',
      'scroll_to',
      'type',
      'press',
      'select',
      'check',
      'drag',
      'upload',
      'scroll',
      'navigate',
      'back',
      'screenshot',
      'tap_at',
      'hover_at',
      'type_at',
      'press_at',
      'select_at',
      'locate',
      'start_recording',
      'stop_recording',
      'seed_data',
      'count_nodes',
    ]);
    expect(opened.text).toContain('- seed_data {tenant}: Seed a tenant with demo data.');
    expect(opened.text).toContain('- count_nodes: Count the nodes on screen. [read-only]');
    const detail = await invoke('tools', { tool: 'locate' });
    expect(detail.text).toContain('locator');

    const seeded = await call('seed_data', { tenant: 'acme' });
    expect(seeded.isError, seeded.text).toBe(false);
    expect(seeded.text).toBe('Seeded acme.');
    const counted = await call('count_nodes');
    expect(counted.isError, counted.text).toBe(false);
    expect(counted.text).toMatch(/^\d+ nodes$/);

    const foreign = await call('kiosk_reset');
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('UNKNOWN_TOOL');

    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });

  it('drives a custom engine with the verbs it declares and nothing more', async () => {
    const opened = await invoke('open_session', { target: 'kiosk' });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain('platform kiosk, engine fake');
    expect(opened.text).toContain('button "Start order"');
    const names = catalogNames(opened.text);
    expect(names).toContain('kiosk_reset');
    expect(names).not.toContain('scroll');

    const observed = await call('observe');
    const id = /#(\S+) button "Start order"/.exec(observed.text)?.[1];
    expect(id).toBeDefined();
    const tapped = await call('tap', { target: id! });
    expect(tapped.isError, tapped.text).toBe(false);
    expect(tapped.text).toContain(`Tapped #${id}.`);
    expect(tapped.text).toMatch(/Screen changes since revision|The screen did not change|No listed node changed/);

    // The fake declares no viewport swipe, so scroll is a verb this target lacks.
    const scrolled = await call('scroll', { direction: 'down' });
    expect(scrolled.isError).toBe(true);
    expect(scrolled.text).toContain('UNSUPPORTED_CAPABILITY');
    expect(scrolled.text).toContain('declares no such action');

    const reset = await call('kiosk_reset');
    expect(reset.isError, reset.text).toBe(false);
    expect(reset.text).toBe('kiosk reset');

    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).not.toContain('Cleanup:');
  });

  it('opens another config of the same project without a restart', async () => {
    const opened = await invoke('open_session', { config: 'kiosk.config.ts' });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain('open on target "kiosk-only"');
    expect(opened.text).toContain('config ');
    expect(opened.text).toContain('kiosk.config.ts');
    // The fake declares every node action but no swipe, no back hook, and no pointer kinds: no scroll, no back, and the point tools ride the node verbs.
    expect(catalogNames(opened.text)).toEqual([
      'observe',
      'tap',
      'double_tap',
      'long_press',
      'right_click',
      'hover',
      'scroll_to',
      'type',
      'press',
      'select',
      'check',
      'drag',
      'upload',
      'navigate',
      'screenshot',
      'tap_at',
      'hover_at',
      'type_at',
      'press_at',
      'select_at',
      'locate',
    ]);
    const closed = await invoke('close_session');
    expect(closed.isError, closed.text).toBe(false);
  });
});
