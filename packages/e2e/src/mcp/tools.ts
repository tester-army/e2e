/**
 * The bridge from the agent's AI SDK tools to the MCP `call` tool. The
 * testing agent's vocabulary (the grammar, the engine packs, the project's
 * `defineTool` values) is a set of AI SDK tools: a description, a zod input
 * schema, and an execute function. The server keeps its own tool list fixed
 * and small, and serves that vocabulary as a catalog: `tools` renders it from
 * the same descriptions and schemas the testing agent reads, and `call`
 * validates the arguments against the schema, runs the tool, and renders its
 * output in the MCP result envelope.
 *
 * The schemas are read through the AI SDK's `asSchema`, and the SDK is an
 * optional peer dependency: this module reaches it only through the lazy
 * loader, never a static import, since the CLI loads this module for every
 * command and `e2e init` runs before `ai` is installed.
 */

import type { JSONSchema7, Tool, ToolExecutionOptions, ToolSet } from 'ai';
import type { z } from 'zod';
import { aiSdk, loadAiSdk } from '../agent/ai-sdk.ts';
import { isFailedResult } from '../agent/loop-guards.ts';
import { codedMessage, ConfigurationError, errorMessage } from '../internal/errors.ts';

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
export interface McpToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<Shape>;
  /** Hint for clients: a tool that changes nothing on the app or disk. */
  readonly readOnly: boolean;
  /** Runs the tool on validated arguments; a thrown error becomes an error result. */
  call(args: z.infer<z.ZodObject<Shape>>, extra: McpToolCallExtra): Promise<McpToolResult>;
}

/** Declares one fixed tool with `call` typed from its `inputSchema`. */
export function defineMcpTool<Shape extends z.ZodRawShape>(spec: McpToolSpec<Shape>): McpToolSpec<Shape> {
  return spec;
}

export function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * A failure as a tool result the agent can react to, never a protocol error:
 * the code and message are what a test would have reported.
 */
export function errorResult(cause: unknown): McpToolResult {
  return { content: [{ type: 'text', text: codedMessage(cause) }], isError: true };
}

/**
 * A grammar action's result, marked as an error when the action failed. A
 * failed action still returns the screen it re-observed, as it does for the
 * testing agent, so the result keeps it; its lead (`tap #n9 failed:
 * LOCATOR_NOT_FOUND: …`) carries the code.
 */
export function actionResult(name: string, result: McpToolResult): McpToolResult {
  const lead = result.content.find((part) => part.type === 'text');
  return lead !== undefined && isFailedResult(name, lead.text) ? { ...result, isError: true } : result;
}

/** The same result with every text part passed through `redact`; image parts are the pixel taint's to withhold. */
export function redactResult(result: McpToolResult, redact: (text: string) => string): McpToolResult {
  return {
    ...result,
    content: result.content.map((part) => (part.type === 'text' ? { type: 'text', text: redact(part.text) } : part)),
  };
}

/** How much of a description the catalog shows per tool: its first sentence, bounded. */
const CATALOG_SENTENCE_MAX = 160;

/**
 * The JSON Schema of a tool's arguments, without the draft marker clients
 * never need. A zod schema converts synchronously; a schema that only
 * resolves lazily is shown as an open object rather than awaited, since the
 * catalog is rendered inline. Synchronous, so the session that renders the
 * catalog has loaded the SDK first.
 */
export function toolJsonSchema(tool: ToolSet[string]): JSONSchema7 {
  const raw = aiSdk().asSchema(tool.inputSchema).jsonSchema;
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
  const { asSchema } = await loadAiSdk();
  const schema = asSchema(tool.inputSchema);
  if (schema.validate === undefined) return args;
  const result = await schema.validate(args);
  if (result.success) return result.value;
  throw new ConfigurationError(
    'INVALID_ARGUMENT',
    `call ${name}: ${describeValidationError(result.error)}; tools {tool: ${JSON.stringify(name)}} shows its arguments`,
  );
}

/**
 * The issues a zod (or any standard schema) failure carries, one per line;
 * else the message. The SDK types the failure as a plain `Error`, so the
 * issues are probed on it and on its cause.
 */
function describeValidationError(error: Error): string {
  const issues = issuesOf(error) ?? issuesOf(error.cause);
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

/** What a tool's `toModelOutput` renders for the model. */
type ModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;

/**
 * Renders a tool's output the way the tool renders it for a model: text as
 * text, and a `toModelOutput` that yields file parts as images. Anything
 * else is JSON, so a structured output is never lost.
 */
export async function resultFromOutput(tool: ToolSet[string], output: unknown, input: unknown = undefined): Promise<McpToolResult> {
  if (typeof output === 'string') return textResult(output);
  if (tool.toModelOutput !== undefined) {
    const content = contentFromModelOutput(await tool.toModelOutput({ toolCallId: 'mcp', input, output }));
    if (content !== undefined) return { content };
  }
  return textResult(output === undefined ? 'Done.' : JSON.stringify(output, null, 2));
}

function contentFromModelOutput(output: ModelOutput): McpContent[] | undefined {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return [{ type: 'text', text: output.value }];
    case 'json':
    case 'error-json':
      return [{ type: 'text', text: JSON.stringify(output.value, null, 2) }];
    case 'content': {
      const parts: McpContent[] = [];
      for (const part of output.value) {
        if (part.type === 'text') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'file' && part.data.type === 'data') {
          const data = typeof part.data.data === 'string' ? part.data.data : Buffer.from(new Uint8Array(part.data.data)).toString('base64');
          parts.push({ type: 'image', data, mimeType: part.mediaType });
        }
      }
      return parts.length === 0 ? undefined : parts;
    }
    default:
      return undefined;
  }
}
