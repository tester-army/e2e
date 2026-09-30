/** The one way a built-in tool is typed: a closed input schema, without loading `ai`. */

import type { Tool, ToolExecutionOptions } from 'ai';
import type { z } from 'zod';

/** The model-facing shape of a tool result: text, or text with a screenshot attached. */
export type ModelOutput =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'content';
      readonly value: ({ readonly type: 'text'; readonly text: string } | { readonly type: 'file'; readonly data: { readonly type: 'data'; readonly data: string }; readonly mediaType: string })[];
    };

/**
 * A plain AI SDK function tool with its input typed from the schema — what
 * `tool()` from `ai` does, without loading `ai` to do it. The schema is
 * closed here, once for every tool: a field it does not declare fails
 * validation, and the SDK hands the failure back to the model as the call's
 * result instead of stripping the field and running the call without it.
 */
export function schemaTool<Schema extends z.ZodObject, Output = string>(definition: {
  readonly description: string;
  readonly inputSchema: Schema;
  readonly execute: (input: z.output<Schema>, options: ToolExecutionOptions<unknown>) => Promise<Output>;
  /** Maps a structured result onto model content; a string result needs none. */
  readonly toModelOutput?: (options: { readonly output: Output }) => ModelOutput;
}): Tool {
  return { ...definition, inputSchema: definition.inputSchema.strict() } as Tool;
}
