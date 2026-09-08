/**
 * The tool contract the server registers and the result envelopes every tool
 * returns. A tool is a name, a description, a zod input schema, and a body;
 * the server turns each into an MCP registration the same way.
 */

import { errorMessage, E2EError, isForeignE2EError } from '../internal/errors.ts';

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
  /** A zod object schema for the arguments. */
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
