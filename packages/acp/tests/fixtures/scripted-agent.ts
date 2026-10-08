/**
 * A scripted ACP agent on stdio, for tests. `ACP_SCRIPT` is a JSON array
 * with one entry per prompt turn, or an object keyed by text the prompt
 * contains, each a list of moves: call one of the
 * client's MCP tools, ask permission for a tool of the agent's own, run one
 * without asking, say something, or hang until cancelled or for good. Every prompt and tool result is appended to `ACP_LOG` as JSON
 * lines, with the tool list the session saw, and the `E2E_` variables and
 * `CODEX_CONFIG` it started with. `ACP_USAGE` is the usage each turn reports. With `ACP_HANG_INIT` set, the agent never
 * answers `initialize`.
 */

import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type McpServer, type Usage } from '@agentclientprotocol/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Move =
  /** `on` picks the target id: the newest screen line that contains it. */
  | { readonly call: string; readonly on?: string; readonly args?: Record<string, unknown> }
  | { readonly own: string; readonly kind?: string; readonly rawInput?: Record<string, unknown>; readonly meta?: Record<string, unknown> }
  | { readonly ran: string; readonly kind?: string; readonly status?: 'completed' | 'failed' }
  | { readonly say: string }
  | { readonly hang: true }
  | { readonly ignoreCancel: true };

/** Moves per turn in order, or per step: the moves of the first key the prompt contains. */
const script = JSON.parse(process.env['ACP_SCRIPT'] ?? '[]') as Move[][] | Record<string, Move[]>;
const movesFor = (prompt: string, index: number): Move[] =>
  Array.isArray(script) ? (script[index] ?? []) : (Object.entries(script).find(([key]) => prompt.includes(key))?.[1] ?? []);
const log = (entry: unknown) => {
  if (process.env['ACP_LOG'] !== undefined) appendFileSync(process.env['ACP_LOG'], `${JSON.stringify(entry)}\n`);
};

log({ pid: process.pid });
log({ env: Object.keys(process.env).filter((name) => name.startsWith('E2E_')).toSorted(), codexConfig: process.env['CODEX_CONFIG'] ?? null });

let mcp: Client | undefined;
/** The screen lines the agent read this turn, newest first: each tool result's changes, then the prompt's screen. */
let screen = '';
let turn = 0;
let cancelRequested = false;
let cancelled: (() => void) | undefined;

const connection = new AgentSideConnection(
  (client) => ({
    initialize: () =>
      process.env['ACP_HANG_INIT'] === undefined
        ? {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
            agentInfo: { name: 'scripted-agent', version: '1' },
            authMethods: [],
          }
        : new Promise<never>(() => undefined),
    newSession: async (params) => {
      const server = params.mcpServers[0] as Extract<McpServer, { type: 'http' }>;
      mcp = new Client({ name: 'scripted-agent', version: '1' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const { tools } = await mcp.listTools();
      log({ session: { cwd: params.cwd, server: server.name, meta: params._meta ?? null, tools: tools.map((tool) => tool.name) } });
      return {
        sessionId: 's1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'fast',
            options: [
              { value: 'fast', name: 'Fast' },
              { value: 'slow', name: 'Slow' },
            ],
          },
        ],
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'read-only', name: 'Read only' },
          ],
        },
      };
    },
    setSessionMode: (params) => {
      log({ mode: params.modeId });
      return {};
    },
    setSessionConfigOption: (params) => {
      log({ config: { [params.configId]: params.value } });
      return { configOptions: [] };
    },
    authenticate: () => ({}),
    closeSession: () => {
      log({ closed: true });
      return {};
    },
    cancel: () => {
      log({ cancelled: true });
      cancelRequested = true;
      cancelled?.();
    },
    prompt: async (params) => {
      const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
      log({ prompt: text });
      screen = text;
      cancelRequested = false;
      for (const move of movesFor(text, turn++)) {
        if ('say' in move) {
          await client.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: move.say } } });
        } else if ('own' in move) {
          const toolCall = {
            toolCallId: `own-${turn}-${move.own}`,
            title: move.own,
            ...(move.kind === undefined ? {} : { kind: move.kind as 'execute' }),
            ...(move.rawInput === undefined ? {} : { rawInput: move.rawInput }),
            ...(move.meta === undefined ? {} : { _meta: move.meta }),
          };
          await client.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'tool_call', ...toolCall } });
          const answer = await client.requestPermission({
            sessionId: 's1',
            toolCall,
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          });
          log({ permission: move.own, outcome: answer.outcome });
        } else if ('ran' in move) {
          // A tool of the agent's own that runs without asking.
          const toolCallId = `ran-${turn}-${move.ran}`;
          await client.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId, title: move.ran, kind: (move.kind ?? 'read') as 'read', status: 'in_progress' } });
          await client.sessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId, status: move.status ?? 'completed' } });
          log({ ran: move.ran });
        } else if ('ignoreCancel' in move) {
          await new Promise<never>(() => undefined);
        } else if ('hang' in move) {
          if (!cancelRequested) {
            await new Promise<void>((resolve) => {
              cancelled = resolve;
            });
          }
          return { stopReason: 'cancelled' };
        } else {
          const id = move.on === undefined ? undefined : idOf(move.on);
          const result = await mcp!.callTool({ name: move.call, arguments: { ...move.args, ...(id === undefined ? {} : { target: id }) } });
          const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
          if (result.isError !== true) screen = `${content.map((part) => part.text ?? '').join('\n')}\n${screen}`;
          log({ call: move.call, result });
        }
      }
      await client.sessionUpdate({
        sessionId: 's1',
        update: { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.01 * turn, currency: 'USD' } },
      });
      return { stopReason: 'end_turn', usage: JSON.parse(process.env['ACP_USAGE'] ?? '{"totalTokens":15,"inputTokens":10,"outputTokens":5,"cachedReadTokens":4}') as Usage };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);
void connection;

function idOf(on: string): string | undefined {
  const line = screen.split('\n').find((entry) => entry.includes(on));
  return line?.match(/#(\S+)/)?.[1];
}
