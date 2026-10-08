/**
 * One ACP agent process and one session in it.
 *
 * The agent process starts in the project directory, so a command installed
 * there resolves, and gets `initialize` and one `session/new` in an empty
 * temporary directory with the step tools as its only MCP server. The
 * client advertises no file system or terminal capability, and answers
 * permission requests itself: calls of the step tools are allowed, anything
 * else is rejected. Each `prompt` is one `session/prompt` and resolves when
 * the agent's turn ends.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type ToolCallUpdate,
  type Usage,
} from '@agentclientprotocol/sdk';
import { ConfigurationError } from 'e2e/engine';
import { MCP_SERVER_NAME, serveTools, type ServedTool, type ToolServer } from './mcp.ts';

/** Tool kinds an agent uses for its own tools and subagents; never a call of ours without an adapter's mark. */
const BUILT_IN_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'switch_mode']);

/** ACP's error code for a request the agent refuses until the user signs in. */
const AUTH_REQUIRED = -32000;

/** Variables e2e reads secret and credential values from: the agent never needs them. */
const SECRET_VARIABLE = /^E2E_(?:SECRET|USER)_/;

/** How to start one agent and what its session gets. */
export interface AgentLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly model?: string | undefined;
  readonly mode?: string | undefined;
  readonly sessionMeta?: Readonly<Record<string, unknown>> | undefined;
  /** How the user signs the agent in, for a session it refuses until they do. */
  readonly signIn?: string | undefined;
}

/** What one prompt turn reported. */
export interface TurnReport {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stopReason: string;
  readonly usage?: Usage;
  /** The turn's cost in USD, when the agent reports a session cost. */
  readonly costUsd?: number;
  /** The agent's text replies during the turn. */
  readonly text: string;
  /** Tool calls of the agent's own that asked permission and were rejected. */
  readonly rejected: readonly string[];
  /** Tool calls of the agent's own that ran without asking. */
  readonly ran: readonly string[];
}

/** A turn's tool calls of the agent's own, by call id: the ones rejected when they asked, and the ones that ran anyway. */
interface OwnCalls {
  readonly rejected: Map<string, string>;
  readonly ran: Map<string, string>;
}

/** A running agent session. */
export interface AcpSession {
  prompt(text: string): Promise<TurnReport>;
  /** Cancels the turn in flight, if any. */
  cancel(): void;
  close(): void;
  /** The model the session runs, when the agent names it. */
  readonly modelId: string | undefined;
  readonly agentName: string | undefined;
}

/**
 * Starts the agent, initializes it, and opens a session with the tools.
 * Aborting `signal` before the session is open stops the agent and the tool
 * server and rejects. `onOwnTool` hears of every tool of the agent's own
 * that ran without asking, as it completes.
 */
export async function startSession(
  launch: AgentLaunch,
  tools: readonly ServedTool[],
  signal: AbortSignal,
  onOwnTool: (title: string) => void = () => undefined,
): Promise<AcpSession> {
  signal.throwIfAborted();
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-acp-'));
  let server: ToolServer | undefined;
  // Started before anything can fail, so teardown can close it even when the startup race is lost while it binds.
  const serving = serveTools(tools);
  serving.catch(() => undefined);
  const child = spawn(launch.command, [...launch.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: withoutSecrets({ ...process.env, ...launch.env }),
  });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-2000);
  });
  // A dead agent must not take the test worker down with a pipe error.
  child.stdin.on('error', () => undefined);
  const exited = new Promise<never>((_, reject) => {
    child.on('error', (error) => reject(new Error(`could not start ${launch.command}: ${error.message}`)));
    child.on('exit', (code, exitSignal) =>
      reject(new Error(`the agent exited (${exitSignal ?? `code ${code}`})${stderr === '' ? '' : `: ${lastLine(stderr)}`}`)),
    );
  });
  exited.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('the step ended while the agent was starting'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  /** Ends a startup step early when the agent exits or the attempt ends. */
  const startup = <T>(step: Promise<T>): Promise<T> => Promise.race([exited, aborted, step]);

  const ours = new Set(tools.map((tool) => tool.name));
  const calls = new Map<string, Partial<ToolCallUpdate>>();
  const turn: TurnState = { cost: undefined, text: '', own: { rejected: new Map(), ran: new Map() } };
  const client: Client = {
    requestPermission: (params) => answerPermission(params, ours, calls, turn.own),
    sessionUpdate: (params) => observe(params, ours, calls, turn, onOwnTool),
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  );
  const teardown = () => {
    child.stdin.end();
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3_000).unref();
    void serving.then((started) => started.close(), () => undefined);
    rmSync(cwd, { recursive: true, force: true });
  };

  let initialize: InitializeResponse;
  let sessionId: string;
  let modelId: string | undefined;
  try {
    server = await startup(serving);
    initialize = await startup(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'e2e', version: '1' },
      }),
    );
    if (initialize.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new ConfigurationError('INVALID_CONFIG', `${launch.command} does not accept MCP servers over HTTP, which the step tools need`);
    }
    const session = await startup(
      connection.newSession({
        cwd,
        mcpServers: [{ type: 'http', name: MCP_SERVER_NAME, url: server.url, headers: [] }],
        ...(launch.sessionMeta === undefined ? {} : { _meta: { ...launch.sessionMeta } }),
      }),
    );
    sessionId = session.sessionId;
    const modelOption = session.configOptions?.find((option) => option.category === 'model' || option.id === 'model');
    if (launch.model !== undefined) {
      const offered = modelOption === undefined ? [] : selectValues(modelOption);
      if (modelOption === undefined || !offered.includes(launch.model)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `the agent does not offer model ${launch.model}${offered.length === 0 ? '' : `; it offers ${offered.join(', ')}`}`,
        );
      }
      await startup(connection.setSessionConfigOption({ sessionId, configId: modelOption.id, value: launch.model }));
      modelId = launch.model;
    } else if (modelOption?.type === 'select') {
      modelId = String(modelOption.currentValue);
    }
    if (launch.mode !== undefined) await startup(selectMode(connection, session, launch.mode));
  } catch (error) {
    teardown();
    if (isAuthRequired(error)) {
      throw new Error(`the agent is not signed in${launch.signIn === undefined ? '' : `: ${launch.signIn}`}`, { cause: error });
    }
    const details = detailsOf(error);
    if (details !== undefined) throw new Error(`${error instanceof Error ? error.message : String(error)}: ${details}`, { cause: error });
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }

  let closed = false;
  return {
    modelId,
    agentName: initialize.agentInfo?.name,
    async prompt(text) {
      turn.text = '';
      turn.own = { rejected: new Map(), ran: new Map() };
      const costBefore = turn.cost;
      const started = Date.now();
      const response = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }), exited]);
      const costUsd = turn.cost === undefined ? undefined : turn.cost - (costBefore ?? 0);
      return {
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        stopReason: response.stopReason,
        ...(response.usage == null ? {} : { usage: response.usage }),
        ...(costUsd === undefined ? {} : { costUsd }),
        text: turn.text,
        rejected: [...turn.own.rejected.values()],
        ran: [...turn.own.ran.values()],
      };
    },
    cancel() {
      void connection.cancel({ sessionId }).catch(() => undefined);
    },
    close() {
      if (closed) return;
      closed = true;
      // Synchronous to the end, so a worker exiting right after the attempt still stops the agent.
      if (initialize.agentCapabilities?.sessionCapabilities?.close != null) {
        void connection.closeSession({ sessionId }).catch(() => undefined);
      }
      teardown();
    },
  };
}

/** The agent's environment without the variables e2e reads secrets from, wherever they came from. */
function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_VARIABLE.test(name)));
}

/** What an agent said about a refused request beyond its message, e.g. the Claude adapter's `data.details`. */
function detailsOf(error: unknown): string | undefined {
  const data = typeof error === 'object' && error !== null ? (error as { data?: unknown }).data : undefined;
  const details = typeof data === 'object' && data !== null ? (data as { details?: unknown }).details : data;
  return typeof details === 'string' && details !== '' ? details : undefined;
}

function isAuthRequired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === AUTH_REQUIRED;
}

async function selectMode(
  connection: ClientSideConnection,
  session: Awaited<ReturnType<ClientSideConnection['newSession']>>,
  mode: string,
): Promise<void> {
  const option = session.configOptions?.find((entry) => entry.category === 'mode');
  if (option !== undefined && selectValues(option).includes(mode)) {
    await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: option.id, value: mode });
  } else if (session.modes?.availableModes.some((entry) => entry.id === mode) === true) {
    await connection.setSessionMode({ sessionId: session.sessionId, modeId: mode });
  } else {
    throw new ConfigurationError('INVALID_CONFIG', `the agent has no mode ${mode}`);
  }
}

/** The values of a select config option, groups flattened. */
function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) => ('group' in entry ? entry.options.map((inner) => inner.value) : [entry.value]));
}

/** What the session gathers over one prompt turn. */
interface TurnState {
  cost: number | undefined;
  text: string;
  own: OwnCalls;
}

function observe(
  { update }: SessionNotification,
  ours: ReadonlySet<string>,
  calls: Map<string, Partial<ToolCallUpdate>>,
  turn: TurnState,
  onOwnTool: (title: string) => void,
): void {
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const { sessionUpdate: _, ...fields } = update;
      const call = { ...calls.get(update.toolCallId), ...defined(fields) };
      calls.set(update.toolCallId, call);
      // A call of the agent's own that finished, done or failed, without a permission we rejected ran without asking.
      const finished = call.status === 'completed' || call.status === 'failed';
      const ran = finished && !turn.own.rejected.has(update.toolCallId) && !turn.own.ran.has(update.toolCallId);
      if (ran && !isOurs(call, undefined, ours)) {
        const title = titleOf(call);
        turn.own.ran.set(update.toolCallId, title);
        onOwnTool(title);
      }
      break;
    }
    case 'agent_message_chunk':
      if (update.content.type === 'text') turn.text += update.content.text;
      break;
    case 'usage_update':
      if (update.cost != null && update.cost.currency === 'USD') turn.cost = update.cost.amount;
      break;
    default:
      break;
  }
}

/** Allows calls of the step tools; rejects everything else. */
function answerPermission(
  params: RequestPermissionRequest,
  ours: ReadonlySet<string>,
  calls: Map<string, Partial<ToolCallUpdate>>,
  own: OwnCalls,
): RequestPermissionResponse {
  const toolCall = { ...calls.get(params.toolCall.toolCallId), ...defined(params.toolCall) };
  const allowed = isOurs(toolCall, params['_meta'] ?? undefined, ours);
  if (!allowed) own.rejected.set(params.toolCall.toolCallId, titleOf(toolCall));
  const kinds = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const option = kinds.map((kind) => params.options.find((entry) => entry.kind === kind)).find((entry) => entry !== undefined);
  return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/**
 * Whether a tool call is one of ours. ACP has no standard field for the MCP
 * server behind a call, so this reads what the adapters fill in, never text
 * the agent wrote: the Claude adapter's `_meta.claudeCode.toolName`; the
 * server and tool of a call the Codex adapter marks as an MCP call; and
 * otherwise, for a call of no built-in kind, a raw input that is just a
 * server, a tool, and its arguments. Anything else is not ours.
 */
function isOurs(toolCall: Partial<ToolCallUpdate>, requestMeta: Record<string, unknown> | undefined, ours: ReadonlySet<string>): boolean {
  const meta = (toolCall['_meta'] ?? {}) as { claudeCode?: { toolName?: unknown }; is_mcp_tool_call?: unknown };
  if (meta.claudeCode !== undefined) {
    const name = meta.claudeCode.toolName;
    const prefix = `mcp__${MCP_SERVER_NAME}__`;
    return typeof name === 'string' && name.startsWith(prefix) && ours.has(name.slice(prefix.length));
  }
  if (meta.is_mcp_tool_call === true || requestMeta?.['is_mcp_tool_approval'] === true) return mcpCallOf(toolCall.rawInput, ours);
  if (toolCall.kind != null && BUILT_IN_KINDS.has(toolCall.kind)) return false;
  return mcpCallOf(toolCall.rawInput, ours);
}

function titleOf(call: Partial<ToolCallUpdate>): string {
  return call.title ?? call.kind ?? 'tool';
}

/** Whether a raw input is an MCP call of one of our tools: our server, the tool's name, and its arguments, nothing else. */
function mcpCallOf(rawInput: unknown, ours: ReadonlySet<string>): boolean {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return false;
  const fields = rawInput as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => MCP_CALL_FIELDS.has(key))) return false;
  const server = fields['server'] ?? fields['serverName'] ?? fields['server_name'];
  const tool = fields['tool'] ?? fields['toolName'] ?? fields['tool_name'];
  return server === MCP_SERVER_NAME && typeof tool === 'string' && ours.has(tool);
}

/** The fields of an MCP call's raw input as adapters report it. */
const MCP_CALL_FIELDS = new Set(['server', 'serverName', 'server_name', 'tool', 'toolName', 'tool_name', 'arguments', 'args', 'input']);

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null)) as Partial<T>;
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}
