/**
 * The `e2e mcp` server: a live session on the app for a coding agent, with
 * the skill as resources, served over one stdio transport. The tool list is
 * four tools and never changes: the session's own vocabulary is a catalog
 * behind `call`, so it follows the config the agent opens rather than the
 * config the server started next to. Streams are injected, so the CLI hands
 * it the process's and a test hands it pipes.
 */

import type { Readable, Writable } from 'node:stream';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readGuide, skillTopics } from '../cli/skill.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { loadProjectConfig } from './config.ts';
import { SessionHost } from './session.ts';
import { errorResult } from './tools.ts';

export interface ServeOptions {
  readonly cwd: string;
  /** The config every session loads unless `open_session` names one. */
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

const INSTRUCTIONS = `e2e is a local-first end-to-end test runner; this server drives an e2e project's app (its e2e.config.ts) live.
Call open_session (optionally with a target and a config path) to get a session, its tool catalog, and the first observation. Then call {tool, args} runs any catalog tool: observe, the grammar its engine honors, type_secret, locate, screenshot, and the project's own tools; tools lists them, tools {tool} shows one tool's arguments. close_session when done.
Write deterministic tests (tests/*.e2e.ts) from what you saw and run them with the CLI: npx e2e run <file>. Resources e2e://guide and e2e://guide/{topic} hold the writing guide.`;

type LogLevel = 'info' | 'warning' | 'error';

/** Serves until the client disconnects or `signal` aborts; resolves with the exit code. */
export async function serveMcp(options: ServeOptions): Promise<number> {
  const server = new McpServer(
    { name: 'e2e', title: 'e2e', version: options.version },
    { capabilities: { logging: {}, tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const log = (level: LogLevel, message: string): void => {
    options.log(`[${level}] ${message}`);
    if (server.isConnected()) void server.sendLoggingMessage({ level, logger: 'e2e', data: message }).catch(() => undefined);
  };

  const host = new SessionHost({
    loadConfig: (configPath) => loadProjectConfig({ cwd: options.cwd, configPath: configPath ?? options.configPath, env: options.env }),
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
        inputSchema: spec.inputSchema,
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: false },
      },
      async (args, extra) => {
        // A failure is a result the agent can react to, never a protocol error.
        try {
          return await spec.call(args, { signal: extra.signal });
        } catch (cause) {
          return errorResult(cause);
        }
      },
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
  log('info', `e2e mcp ${options.version} serving ${options.cwd}`);
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
