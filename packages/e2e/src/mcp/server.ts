/**
 * The `e2e mcp` server: a live session on the app for a coding agent, with
 * the skill as resources, served over one stdio transport. Streams are
 * injected, so the CLI hands it the process's and a test hands it pipes.
 */

import type { Readable, Writable } from 'node:stream';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readGuide, skillTopics } from '../cli/skill.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { loadProjectConfig } from './config.ts';
import { SessionHost } from './session.ts';

export interface ServeOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
  /** The target every session opens on; otherwise a call names one, or the only one is used. */
  readonly target?: string | undefined;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly stdin: Readable;
  /** The protocol stream: nothing else may write to it. */
  readonly stdout: Writable;
  /** Diagnostics for the operator, normally stderr. */
  readonly log: (line: string) => void;
  /** Ends the server from outside: a process signal. */
  readonly signal?: AbortSignal | undefined;
}

const INSTRUCTIONS = `e2e is a local-first end-to-end test runner; this server drives one project's app (its e2e.config.ts) live.
Call open_session, then observe, tap, type, press, select, scroll, navigate, and type_secret to explore the real app the way the testing agent will; verify locators with locate; close_session when done.
Write deterministic tests (tests/*.e2e.ts) from what you saw and run them with the CLI: npx --no-install e2e run <file>. Resources e2e://guide and e2e://guide/{topic} hold the writing guide.`;

type LogLevel = 'info' | 'warning' | 'error';

/** Serves until the client disconnects or `signal` aborts; resolves with the exit code. */
export async function serveMcp(options: ServeOptions): Promise<number> {
  const project = { cwd: options.cwd, configPath: options.configPath, env: options.env };
  const server = new McpServer(
    { name: 'e2e', version: options.version },
    { capabilities: { logging: {}, tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const log = (level: LogLevel, message: string): void => {
    options.log(`[${level}] ${message}`);
    if (server.isConnected()) void server.sendLoggingMessage({ level, logger: 'e2e', data: message }).catch(() => undefined);
  };

  let startupConfig;
  try {
    startupConfig = await loadProjectConfig(project);
  } catch (cause) {
    startupConfig = undefined;
    log('warning', `config not loaded at startup: ${errorMessage(cause)}; open_session loads it again`);
  }
  const host = new SessionHost({
    config: startupConfig,
    loadConfig: () => loadProjectConfig(project),
    env: options.env,
    headed: options.headed,
    defaultTarget: options.target,
    log,
  });

  for (const spec of host.toolSpecs()) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema as never,
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: false },
      },
      (async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => spec.call(args ?? {}, { signal: extra.signal })) as never,
    );
  }
  registerGuide(server);

  const transport = new StdioServerTransport(options.stdin, options.stdout);
  const closed = new Promise<void>((resolve) => {
    // The SDK's Server exposes a plain callback property, not an event target.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    server.server.onclose = () => resolve();
    options.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.connect(transport);
  log('info', `e2e mcp ${options.version} serving ${project.cwd}`);
  await closed;
  try {
    const summary = await host.close('server shutdown');
    if (summary !== 'No session is open.') options.log(summary);
  } catch (cause) {
    options.log(`session teardown failed: ${errorMessage(cause)}`);
  }
  await server.close().catch((cause: unknown) => options.log(`server close failed: ${errorMessage(cause)}`));
  return 0;
}

/** The skill as resources, for clients that read context without a tool call. */
function registerGuide(server: McpServer): void {
  server.registerResource(
    'guide',
    'e2e://guide',
    { title: 'e2e guide', description: 'How to set up e2e, write tests, use agent steps, run the CLI, and read a failing run', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readGuide(undefined) ?? 'The skill is not part of this installation.' }] }),
  );
  server.registerResource(
    'guide-topic',
    new ResourceTemplate('e2e://guide/{topic}', {
      list: async () => ({
        resources: skillTopics().map((topic) => ({ uri: `e2e://guide/${topic}`, name: topic, mimeType: 'text/markdown' })),
      }),
    }),
    { title: 'e2e guide topic', description: `One topic of the guide: ${skillTopics().join(', ')}`, mimeType: 'text/markdown' },
    async (uri, variables) => {
      const topic = String(variables['topic']);
      const text = readGuide(topic);
      if (text === undefined) throw new ConfigurationError('UNKNOWN_TOPIC', `unknown topic "${topic}"; topics: ${skillTopics().join(', ')}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );
}
