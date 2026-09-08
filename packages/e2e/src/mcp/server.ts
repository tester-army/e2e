/**
 * The `e2e mcp` server: the project tools (list, run, read the report) and
 * the skill as resources, served over one stdio transport to a coding agent.
 * Streams are injected, so the CLI hands it the process's and a test hands
 * it pipes.
 */

import type { Readable, Writable } from 'node:stream';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readGuide, skillTopics } from '../cli/skill.ts';
import { ConfigurationError, errorMessage } from '../internal/errors.ts';
import { listTests, readReport, runTests } from './project.ts';
import { errorResult, textResult, type McpToolResult, type McpToolSpec } from './tools.ts';

export interface ServeOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
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

const INSTRUCTIONS = `e2e is a local-first end-to-end test runner; this server serves one project (its e2e.config.ts).
Tools: list_tests, run_tests, read_report. Write deterministic tests (tests/*.e2e.ts), run them with run_tests, and read the digest of the failures. Resources e2e://guide and e2e://guide/{topic} hold the writing guide.`;

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

  let running = false;
  const specs: McpToolSpec[] = [
    {
      name: 'list_tests',
      description:
        'List the tests a run would select, per file, with the target each runs on and the reason when one is skipped, exactly as `e2e list` prints them. Files, tags, and target narrow the selection like the CLI flags do. Read-only; boots no engine.',
      inputSchema: z.object({
        files: z.array(z.string().min(1)).optional().describe('Test files, directories, or globs relative to the project root'),
        tags: z.array(z.string().min(1)).optional(),
        target: z.string().min(1).optional(),
      }),
      readOnly: true,
      call: (args) => guarded(() => listTests(project, args as Parameters<typeof listTests>[1])),
    },
    {
      name: 'run_tests',
      description:
        'Run the tests (all, or a selection by files, tags, and target) exactly like `e2e run`, and return a digest of the report: failures with code, message, source line, failing step, and artifact paths. One run at a time; cancelling the call interrupts the run.',
      inputSchema: z.object({
        files: z.array(z.string().min(1)).optional().describe('Test files, directories, or globs relative to the project root'),
        tags: z.array(z.string().min(1)).optional(),
        tagMode: z.enum(['any', 'all']).optional(),
        target: z.string().min(1).optional(),
        headed: z.boolean().optional().describe('Show the UI while tests run'),
        noCache: z.boolean().optional().describe('Run with the agent trace cache off'),
        retries: z.number().int().min(0).max(10).optional(),
        workers: z.number().int().min(1).max(32).optional(),
      }),
      readOnly: false,
      call: async (args, extra) => {
        if (running) return errorResult(new ConfigurationError('RUN_IN_PROGRESS', 'a run is already in progress; wait for it to finish'));
        running = true;
        try {
          const outcome = await runTests(project, args as Parameters<typeof runTests>[1], {
            progress: (message) => extra.progress(message),
            signal: extra.signal,
          });
          return { content: [{ type: 'text', text: outcome.text }], ...(outcome.exitCode === 0 ? {} : { isError: outcome.exitCode !== 1 }) };
        } catch (cause) {
          return errorResult(cause);
        } finally {
          running = false;
        }
      },
    },
    {
      name: 'read_report',
      description:
        'Digest the last run from .e2e/report.json (or a given report path): status, counts, run errors, and every failed test with its code, message, source line, failing step, agent explanation, and artifact paths. Read-only.',
      inputSchema: z.object({ path: z.string().min(1).optional().describe('A report.json path; default: the project\'s .e2e/report.json') }),
      readOnly: true,
      call: (args) => guarded(() => readReport(project, args as Parameters<typeof readReport>[1])),
    },
  ];

  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema as never,
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: false },
      },
      (async (args: Record<string, unknown>, extra: ToolExtra) =>
        spec.call(args ?? {}, {
          signal: extra.signal,
          progress: (message) => {
            const token = progressToken(extra);
            if (token === undefined) return;
            void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 0, message } }).catch(() => undefined);
          },
        })) as never,
    );
  }

  registerResources(server, project.cwd);

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
  await server.close().catch((cause: unknown) => options.log(`server close failed: ${errorMessage(cause)}`));
  return 0;
}

/** The subset of the SDK's request extra the tools use. */
interface ToolExtra {
  readonly signal: AbortSignal;
  sendNotification(notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }): Promise<void>;
  readonly [key: string]: unknown;
}

/** The client's progress token, when it asked for progress on this request. */
function progressToken(extra: ToolExtra): string | number | undefined {
  const meta = extra['_meta'] as { progressToken?: unknown } | undefined;
  const token = meta?.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

async function guarded(body: () => Promise<string>): Promise<McpToolResult> {
  try {
    return textResult(await body());
  } catch (cause) {
    return errorResult(cause);
  }
}

/** The skill as resources, plus the latest report, for clients that read context without a tool call. */
function registerResources(server: McpServer, cwd: string): void {
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
  server.registerResource(
    'report',
    'e2e://report/latest',
    { title: 'Latest run digest', description: 'The digest of the project\'s .e2e/report.json', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readReport({ cwd, env: process.env }, {}) }] }),
  );
}
