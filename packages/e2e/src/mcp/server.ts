/**
 * The `e2e mcp` server: a live session on the app for a coding agent, with
 * the skill as resources, served over one stdio transport. The tool list is
 * four tools and never changes: the session's own vocabulary is a catalog
 * behind `call`, so it follows the config the agent opens rather than the
 * config the server started next to. Streams are injected, so the CLI hands
 * it the process's and a test hands it pipes.
 */

import type { Readable, Writable } from 'node:stream';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readGuide, skillTopics } from '../cli/skill.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { processSecrets } from '../run/secrecy.ts';
import { loadProjectConfig, locateProjectConfig } from './config.ts';
import { SessionHost, type SessionHostOptions } from './session.ts';
import type { McpSessionSummary } from './usage.ts';

/** The client as it named itself in `initialize`. */
export interface McpClient {
  readonly name: string;
  readonly version: string;
}

export interface ServeOptions {
  readonly cwd: string;
  /** The config every session loads unless `open_session` names one. */
  readonly configPath?: string | undefined;
  /** The target every session opens on; otherwise a call names one, or the only one is used. */
  readonly target?: string | undefined;
  /** Whether a session shows its UI when `open_session` does not set `headed`. */
  readonly headed: boolean;
  /** How many sessions may be open at once, from `--max-sessions`. */
  readonly maxSessions?: number | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly stdin: Readable;
  /** The protocol stream: nothing else may write to it. */
  readonly stdout: Writable;
  /** Diagnostics for the operator, normally stderr. */
  readonly log: (line: string) => void;
  /** Holds what the process prints while a config loads, until its secrets are known. */
  readonly withholdOutput?: SessionHostOptions['withholdOutput'];
  /** Ends the server from outside: a process signal. */
  readonly signal?: AbortSignal | undefined;
  /** Told once per `open_session`, when its session closes or its open fails, with the client that asked; undefined before `initialize`. */
  readonly onSessionEnd?: ((summary: McpSessionSummary, client: McpClient | undefined) => void) | undefined;
}

const INSTRUCTIONS = `e2e is a local-first end-to-end test runner; this server drives an e2e project's app (its e2e.config.ts) live.
Call open_session (optionally with a target, a config path, and headed: true when the user wants to watch) to get a session, its tool catalog, and the first observation. Then call {tool, args} runs any catalog tool: observe, the grammar its engine honors, type_secret, locate, screenshot, start_recording and stop_recording when the engine records video (a video of the app for a pull request), and the project's own tools; tools lists them, tools {tool} shows one tool's arguments. close_session when done.
Several sessions can be open at once, each with its own browser or device, so parallel agents (subagents) each open their own: pass the session id from open_session to every tools, call, and close_session.
Write deterministic tests (tests/*.e2e.ts) from what you saw and run them with the CLI: npx e2e run <file>. Resources e2e://guide and e2e://guide/{topic} hold the writing guide.`;

type LogLevel = 'info' | 'warning' | 'error';

/** Serves until the client disconnects or `signal` aborts; resolves with the exit code. */
export async function serveMcp(options: ServeOptions): Promise<number> {
  const server = new McpServer(
    { name: 'e2e', title: 'e2e', version: options.version },
    { capabilities: { logging: {}, tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  let disconnected = false;
  const log = (level: LogLevel, message: string): void => {
    options.log(`[${level}] ${message}`);
    if (!disconnected && server.isConnected()) void server.sendLoggingMessage({ level, logger: 'e2e', data: message }).catch(() => undefined);
  };

  const host = new SessionHost({
    locateConfig: (configPath) => locateProjectConfig({ cwd: options.cwd, configPath: configPath ?? options.configPath }),
    loadConfig: (configPath) => loadProjectConfig(configPath, options.env),
    withholdOutput: options.withholdOutput,
    env: options.env,
    headed: options.headed,
    maxSessions: options.maxSessions,
    defaultTarget: options.target,
    log,
    onSessionEnd: (summary) => {
      const client = server.server.getClientVersion();
      options.onSessionEnd?.(summary, client === undefined ? undefined : { name: client.name, version: client.version });
    },
  });

  for (const spec of host.toolSpecs()) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: false },
      },
      (args, ctx) => spec.call(args, { signal: ctx.mcpReq.signal }),
    );
  }
  registerGuide(server);

  const transport = new StdioServerTransport(options.stdin, options.stdout);
  const closed = new Promise<string>((resolve) => {
    // The SDK's Server exposes a plain callback property, not an event target.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    server.server.onclose = () => resolve('server shutdown');
    options.signal?.addEventListener('abort', () => resolve('server shutdown'), { once: true });
    // The stdio transport never closes on its own: a client that ends stdin,
    // or dies and takes both pipes with it, is noticed here. A write to a
    // stdout nobody reads fails with EPIPE; with no listener that error
    // would kill the server and leave its app processes running.
    const gone = (): void => {
      disconnected = true;
      resolve('client disconnected');
    };
    options.stdin.once('end', gone);
    options.stdin.once('error', gone);
    options.stdout.on('error', gone);
  });
  await server.connect(transport);
  log('info', `e2e mcp ${options.version} serving ${options.cwd}`);
  const reason = await closed;
  if (disconnected) options.log('[info] client disconnected; closing every session');
  try {
    const summary = await host.closeAll(reason);
    if (summary !== undefined) options.log(summary);
  } catch (cause) {
    options.log(`session teardown failed: ${processSecrets.redact(errorMessage(cause))}`);
  }
  await server.close().catch((cause: unknown) => options.log(`server close failed: ${processSecrets.redact(errorMessage(cause))}`));
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
