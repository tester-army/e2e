/**
 * Scripted tool-calling AI SDK model for default-executor tests. Where
 * `fake-model.ts` scripts the single-call adapter path, this fake scripts the
 * ToolLoopAgent path: every `doGenerate` answers with tool calls, so tests
 * exercise the real loop — tool dispatch, updated-screen results, stop
 * conditions, and the `complete_step` verdict — without a provider.
 */

import type { ModelInstance } from '../../src/types.ts';
import { createScriptedInstance, scriptedResult } from './scripted-model.ts';

export interface LoopCall {
  /** One-based generate round within the step. */
  readonly turn: number;
  /** Tool names offered by the loop, sorted. */
  readonly toolNames: readonly string[];
  /** Text of the first user message: instruction, params, initial screen. */
  readonly prompt: string;
  /** Text outputs of every executed tool so far, oldest first. */
  readonly toolResults: readonly string[];
  /** The newest tool result, or '' on the first turn. */
  readonly lastToolResult: string;
}

export interface LoopToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export type LoopResponder = (call: LoopCall) => readonly LoopToolCall[];

/** Recorded calls, newest last. Cleared by every installFakeLoopModel call. */
export const loopCalls: LoopCall[] = [];

/** The structural surface the AI SDK hands a V4 model. */
interface RawPart {
  readonly type: string;
  readonly text?: string;
  readonly output?: { readonly type: string; readonly value?: unknown };
}

interface RawMessage {
  readonly role: string;
  readonly content: string | readonly RawPart[];
}

interface RawOptions {
  readonly prompt: readonly RawMessage[];
  readonly tools?: readonly { readonly name: string }[];
}

/** Builds the scripted tool-loop model and clears the call log. */
export function installFakeLoopModel(respond: LoopResponder): ModelInstance {
  loopCalls.length = 0;
  let turn = 0;
  let callCounter = 0;
  return createScriptedInstance('fake-loop', 'scripted-loop', async (options: RawOptions) => {
    turn += 1;
    const toolResults = collectToolResults(options.prompt);
    const call: LoopCall = {
      turn,
      toolNames: (options.tools ?? []).map((tool) => tool.name).toSorted(),
      prompt: firstUserText(options.prompt),
      toolResults,
      lastToolResult: toolResults[toolResults.length - 1] ?? '',
    };
    loopCalls.push(call);
    const content = respond(call).map((toolCall) => ({
      type: 'tool-call' as const,
      toolCallId: `scripted_${(callCounter += 1)}`,
      toolName: toolCall.toolName,
      input: JSON.stringify(toolCall.input),
    }));
    return scriptedResult(content, 'tool-calls');
  });
}

function firstUserText(prompt: readonly RawMessage[]): string {
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((part) => part.type === 'text' && part.text !== undefined)
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/** Extracts the text value of every tool-result part, oldest first. */
function collectToolResults(prompt: readonly RawMessage[]): string[] {
  const results: string[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      if (output === undefined) continue;
      if (typeof output.value === 'string') {
        results.push(output.value);
      } else if (output.value !== undefined) {
        results.push(JSON.stringify(output.value));
      }
    }
  }
  return results;
}

/** Finds the observed node id on the first line matching a pattern. */
export function nodeIdFor(observedText: string, pattern: RegExp): string {
  for (const line of observedText.split('\n')) {
    if (!pattern.test(line)) continue;
    const id = /#(\S+)/.exec(line)?.[1];
    if (id !== undefined) return id;
  }
  throw new Error(`no observed node matching ${String(pattern)} in:\n${observedText}`);
}
