/**
 * The bridge from the agent's AI SDK tools to MCP tools. The testing agent's
 * vocabulary (`createGrammarTools`, the engine packs, the project's
 * `defineTool` values) is a set of AI SDK tools: a description, a zod input
 * schema, and an execute function. An MCP tool is the same three things with
 * a different result envelope, so one adapter serves every tool the same way
 * and the coding agent reads exactly the descriptions the testing agent does.
 */

import type { ToolExecutionOptions, ToolSet } from 'ai';
import { errorMessage, E2EError, isForeignE2EError, TestError } from '../internal/errors.ts';

/** One MCP content part this server emits. */
export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** The MCP tool result envelope, as the SDK's `CallToolResult` spells it. */
export interface McpToolResult {
  readonly content: McpContent[];
  readonly isError?: boolean;
  [key: string]: unknown;
}

/** What a tool body gets from the request: cancellation and a progress channel. */
export interface McpToolCallExtra {
  readonly signal: AbortSignal;
  /** One line of progress to the client, when it asked for progress. */
  readonly progress: (message: string) => void;
}

/** What the server needs to register one tool: its contract and its body. */
export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  /** A zod object schema for the arguments, or undefined for a tool without arguments. */
  readonly inputSchema: unknown;
  /** Hint for clients: a tool that changes nothing on the app or disk. */
  readonly readOnly: boolean;
  call(args: Record<string, unknown>, extra: McpToolCallExtra): Promise<McpToolResult>;
}

export function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * A failure as a tool result the agent can react to, never a protocol error:
 * the code and message are what a test would have reported.
 */
export function errorResult(cause: unknown): McpToolResult {
  const code = cause instanceof E2EError || isForeignE2EError(cause) ? `${(cause as { code: string }).code}: ` : '';
  return { content: [{ type: 'text', text: `${code}${errorMessage(cause)}` }], isError: true };
}

/** Which grammar and pack tools change application state; everything else is read-only. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['observe', 'screenshot']);

/**
 * Adapts every tool of an AI SDK toolset. `run` executes the named tool's
 * body wherever the host needs it to run (the live session's queue), so the
 * adapter never captures a session: the toolset it reads schemas from at
 * registration time may be a stub, and the one it executes against later is
 * the live one.
 */
export function adaptToolSet(
  tools: ToolSet,
  run: (name: string, execute: () => Promise<unknown>) => Promise<unknown>,
  live: () => ToolSet,
  isReadOnly: (name: string) => boolean = (name) => READ_ONLY_TOOLS.has(name),
): McpToolSpec[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: typeof tool.description === 'string' ? tool.description : name,
    inputSchema: tool.inputSchema,
    readOnly: isReadOnly(name),
    call: async (args, extra) => {
      try {
        // The live tool is looked up inside the host's run, so a call with no
        // session gets the host's own answer (NO_SESSION), not a missing tool.
        let current: ToolSet[string] | undefined;
        const output = await run(name, async () => {
          current = live()[name];
          if (current?.execute === undefined) {
            throw new TestError('UNSUPPORTED_CAPABILITY', `tool "${name}" is not available in this session`);
          }
          const options: ToolExecutionOptions<unknown> = {
            toolCallId: `mcp-${Date.now().toString(36)}`,
            messages: [],
            abortSignal: extra.signal,
            context: undefined,
          };
          return resolveOutput(await current.execute(args, options));
        });
        return resultFromOutput(current ?? tool, output);
      } catch (cause) {
        return errorResult(cause);
      }
    },
  }));
}

/** An execute function may stream; the last value is the tool's output. */
async function resolveOutput(value: unknown): Promise<unknown> {
  if (value !== null && typeof value === 'object' && Symbol.asyncIterator in value) {
    let last: unknown;
    for await (const part of value as AsyncIterable<unknown>) last = part;
    return last;
  }
  return value;
}

/**
 * Renders a tool's output the way the tool renders it for a model: text as
 * text, and a `toModelOutput` that yields file parts as images. Anything
 * else is JSON, so a structured output is never lost.
 */
export function resultFromOutput(tool: ToolSet[string], output: unknown): McpToolResult {
  if (typeof output === 'string') return textResult(output);
  if (tool.toModelOutput !== undefined) {
    const modelOutput = tool.toModelOutput({ toolCallId: 'mcp', input: undefined, output }) as unknown;
    const content = contentFromModelOutput(modelOutput);
    if (content !== undefined) return { content };
  }
  return textResult(output === undefined ? 'Done.' : JSON.stringify(output, null, 2));
}

function contentFromModelOutput(value: unknown): McpContent[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const output = value as { type?: unknown; value?: unknown };
  if (output.type === 'text' || output.type === 'error-text') {
    return typeof output.value === 'string' ? [{ type: 'text', text: output.value }] : undefined;
  }
  if (output.type === 'json') return [{ type: 'text', text: JSON.stringify(output.value, null, 2) }];
  if (output.type !== 'content' || !Array.isArray(output.value)) return undefined;
  const parts: McpContent[] = [];
  for (const part of output.value as { type?: unknown; text?: unknown; data?: unknown; mediaType?: unknown }[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if ((part.type === 'file' || part.type === 'file-data' || part.type === 'media') && typeof part.mediaType === 'string') {
      const data = typeof part.data === 'string' ? part.data : (part.data as { data?: unknown } | undefined)?.data;
      if (typeof data === 'string') parts.push({ type: 'image', data, mimeType: part.mediaType });
    }
  }
  return parts.length === 0 ? undefined : parts;
}
