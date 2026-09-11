/**
 * The bridge from the agent's AI SDK tools to the MCP `call` tool. The
 * testing agent's vocabulary (the grammar, the engine packs, the project's
 * `defineTool` values) is a set of AI SDK tools: a description, a zod input
 * schema, and an execute function. The server keeps its own tool list fixed
 * and small, and serves that vocabulary as a catalog: `tools` renders it from
 * the same descriptions and schemas the testing agent reads, and `call`
 * validates the arguments against the schema, runs the tool, and renders its
 * output in the MCP result envelope.
 */

import { asSchema, type JSONSchema7, type ToolExecutionOptions, type ToolSet } from 'ai';
import { ConfigurationError, errorMessage, E2EError, isForeignE2EError } from '../internal/errors.ts';

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

/** What a tool body gets from the request. */
export interface McpToolCallExtra {
  readonly signal: AbortSignal;
}

/** What the server registers: the contract and the body of one of its fixed tools. */
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

/** How much of a description the catalog shows per tool: its first sentence, bounded. */
const CATALOG_SENTENCE_MAX = 160;

/**
 * The JSON Schema of a tool's arguments, without the draft marker clients
 * never need. A zod schema converts synchronously; a schema that only
 * resolves lazily is shown as an open object rather than awaited, since the
 * catalog is rendered inline.
 */
export function toolJsonSchema(tool: ToolSet[string]): JSONSchema7 {
  const raw = asSchema(tool.inputSchema).jsonSchema;
  if (typeof (raw as PromiseLike<JSONSchema7>).then === 'function') return { type: 'object' };
  const { $schema: _draft, ...schema } = raw as JSONSchema7;
  return schema;
}

/**
 * One catalog line: the name, the argument names (`?` marks an optional
 * one), the first sentence of the description, and the read-only mark.
 * `- tap {target}: Tap or click one node.`
 */
export function catalogLine(name: string, tool: ToolSet[string], readOnly: boolean): string {
  const schema = toolJsonSchema(tool);
  const required = new Set(schema.required ?? []);
  const args = Object.keys(schema.properties ?? {}).map((key) => (required.has(key) ? key : `${key}?`));
  const signature = args.length === 0 ? name : `${name} {${args.join(', ')}}`;
  return `- ${signature}: ${firstSentence(toolDescription(name, tool))}${readOnly ? ' [read-only]' : ''}`;
}

/** The full contract of one tool: its description and the JSON Schema of its arguments. */
export function describeToolDetail(name: string, tool: ToolSet[string], readOnly: boolean): string {
  return [
    `${name}${readOnly ? ' [read-only]' : ''}`,
    toolDescription(name, tool),
    '',
    'Arguments (JSON Schema):',
    JSON.stringify(toolJsonSchema(tool), null, 2),
  ].join('\n');
}

function toolDescription(name: string, tool: ToolSet[string]): string {
  return typeof tool.description === 'string' && tool.description !== '' ? tool.description : name;
}

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs)\./gi;

function firstSentence(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  const guarded = flat.replaceAll(ABBREVIATIONS, (match) => match.replaceAll('.', '\u0000'));
  const end = guarded.search(/[.!?](?:\s|$)/);
  const sentence = (end === -1 ? guarded : guarded.slice(0, end + 1)).replaceAll('\u0000', '.');
  if (sentence.length <= CATALOG_SENTENCE_MAX) return sentence;
  const cut = sentence.lastIndexOf(' ', CATALOG_SENTENCE_MAX - 1);
  return `${sentence.slice(0, cut > 0 ? cut : CATALOG_SENTENCE_MAX - 1).replace(/[,;:]$/, '')}…`;
}

/**
 * Validates the arguments against the tool's own schema and runs it. The
 * server's `call` tool takes any object, so this is where a wrong argument is
 * caught, with the same message a model would get, before the tool runs.
 */
export async function invokeTool(
  name: string,
  tool: ToolSet[string],
  args: Record<string, unknown>,
  extra: McpToolCallExtra,
): Promise<McpToolResult> {
  if (tool.execute === undefined) {
    throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `tool "${name}" has no execute function`);
  }
  const input = await validateArgs(name, tool, args);
  const options: ToolExecutionOptions<unknown> = {
    toolCallId: `mcp-${Date.now().toString(36)}`,
    messages: [],
    abortSignal: extra.signal,
    context: undefined,
  };
  return resultFromOutput(tool, await resolveOutput(await tool.execute(input, options)), input);
}

async function validateArgs(name: string, tool: ToolSet[string], args: Record<string, unknown>): Promise<unknown> {
  const schema = asSchema(tool.inputSchema);
  if (schema.validate === undefined) return args;
  const result = await schema.validate(args);
  if (result.success) return result.value;
  throw new ConfigurationError(
    'INVALID_ARGUMENT',
    `call ${name}: ${describeValidationError(result.error)}; tools {tool: ${JSON.stringify(name)}} shows its arguments`,
  );
}

/** The issues a zod (or any standard schema) failure carries, one per line; else the message. */
function describeValidationError(error: unknown): string {
  const issues = issuesOf(error) ?? issuesOf((error as { cause?: unknown } | undefined)?.cause);
  if (issues === undefined || issues.length === 0) return errorMessage(error);
  return issues
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      return `${path}${typeof issue.message === 'string' ? issue.message : 'invalid'}`;
    })
    .join('; ');
}

function issuesOf(value: unknown): { path?: unknown; message?: unknown }[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const issues = (value as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as { path?: unknown; message?: unknown }[]) : undefined;
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
export function resultFromOutput(tool: ToolSet[string], output: unknown, input: unknown = undefined): McpToolResult {
  if (typeof output === 'string') return textResult(output);
  if (tool.toModelOutput !== undefined) {
    const modelOutput = tool.toModelOutput({ toolCallId: 'mcp', input, output }) as unknown;
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
