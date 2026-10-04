/**
 * `e2e mcp` with user code that prints a configured secret: the config's
 * top-level code and a project tool writing to stdout and stderr. Stdout is
 * the protocol stream, so what they write there must land on stderr and the
 * protocol must keep working; either way the secret never reaches stderr in
 * the clear. A config that prints a secret and then fails to load has no
 * secrets anyone knows, so what it printed is withheld, not passed on raw.
 * An error nobody caught is logged redacted, and the server shuts down.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const TOKEN = 'user-output-token-42';

const KIOSK = `import { createFakeEngine } from '../../helpers/fake-engine.ts';

export const kiosk = createFakeEngine({
  tree: { ref: { id: 'root', revision: '' }, role: 'root', children: [
    { ref: { id: 'k-1', revision: '' }, role: 'button', name: 'Start order', states: { hidden: false } },
  ] },
});
`;

const CONFIG = `import type { E2EConfig } from 'e2e';
import { defineTool } from 'e2e/agent';
import { z } from 'zod';
import { kiosk } from './kiosk.ts';

const token = '${TOKEN}';
console.log(\`config top level: \${token}\`);

export default {
  targets: [{ name: 'kiosk', platform: 'kiosk', engine: kiosk.engine }],
  secrets: { apiToken: token },
  agents: { default: {
    tools: {
      leak: defineTool(
        {
          description: 'Print the token every way user code can.',
          inputSchema: z.object({}),
          execute: async () => {
            console.log(\`tool console.log: \${token}\`);
            process.stdout.write(\`tool stdout split: \${token.slice(0, 9)}\`);
            process.stdout.write(\`\${token.slice(9)}\\n\`);
            console.error(\`tool console.error: \${token}\`);
            process.stdout.write(\`tool stdout no newline: \${token}\`);
            return 'printed';
          },
        },
        { mutates: false },
      ),
      stray: defineTool(
        {
          description: 'Reject a promise nobody awaits.',
          inputSchema: z.object({}),
          execute: async () => {
            void Promise.reject(new Error(\`stray rejection: \${token}\`));
            return 'rejected';
          },
        },
        { mutates: false },
      ),
    },
  } },
} satisfies E2EConfig;
`;

const BROKEN_CONFIG = `const token = '${TOKEN}-broken';
console.log(\`broken config: \${token}\`);
throw new Error('config refuses to load');
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

describe('e2e mcp redacts what user code prints', { timeout: 120_000 }, () => {
  let project: FixtureProject;
  let client: Client;
  let stderr = '';
  let stderrEnded: Promise<void>;

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return {
      text: result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
      isError: result.isError === true,
    };
  };

  beforeAll(async () => {
    project = createProject({ 'e2e.config.ts': CONFIG, 'kiosk.ts': KIOSK, 'broken.config.ts': BROKEN_CONFIG });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--headless'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), CI: '' },
      stderr: 'pipe',
    });
    transport.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    stderrEnded = new Promise((resolve) => transport.stderr!.once('end', resolve));
    client = new Client({ name: 'e2e-mcp-user-output-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
  });

  it('withholds what a config printed before it failed to load', async () => {
    const opened = await invoke('open_session', { config: 'broken.config.ts' });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain('config refuses to load');
    await vi.waitFor(() => expect(stderr).toContain('withheld'));
    expect(stderr).not.toContain(TOKEN);
  });

  it('keeps the protocol working and redacts the config and a project tool on stdout and stderr', async () => {
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    const leaked = await invoke('call', { tool: 'leak' });
    expect(leaked.isError, leaked.text).toBe(false);
    expect(leaked.text).toBe('printed');
    // The line printed without a newline is released when its call ends.
    await vi.waitFor(() => expect(stderr).toContain('tool stdout no newline: <secret:apiToken>'));
    const stray = await invoke('call', { tool: 'stray' });
    expect(stray.text).toBe('rejected');
    await stderrEnded;

    expect(stderr).not.toContain(TOKEN);
    const lines = stderr.split('\n');
    for (const line of [
      'config top level: <secret:apiToken>',
      'tool console.log: <secret:apiToken>',
      'tool stdout split: <secret:apiToken>',
      'tool console.error: <secret:apiToken>',
      'tool stdout no newline: <secret:apiToken>',
      'e2e mcp: [error] uncaught: Error: stray rejection: <secret:apiToken>',
    ]) {
      expect(lines).toContain(line);
    }
  });
});
