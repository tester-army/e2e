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
  /** Image or file parts attached to user messages, excluding text captions. */
  readonly imageParts: number;
  /**
   * Text of the last user message. Equals `prompt` unless the executor opened
   * the step with a carried-over history, where it is the current step's request.
   */
  readonly lastPrompt: string;
  /** Number of user messages in the request; more than one means carried history or a notice. */
  readonly userMessages: number;
  /** Text outputs of every executed tool so far, oldest first. */
  readonly toolResults: readonly string[];
  /** The newest tool result, or '' on the first turn. */
  readonly lastToolResult: string;
  /** The system prompt of the request. */
  readonly system: string;
  /** How the loop asked for tools: `required`, `auto`, or `tool:<name>` for a named tool. */
  readonly toolChoice: string;
}

export interface LoopToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

/** A turn's scripted answer: tool calls, or prose without any (`{ text }`). Either form may carry `reasoning`. */
export type LoopResponder = (
  call: LoopCall,
) =>
  | readonly LoopToolCall[]
  | { readonly text: string; readonly reasoning?: string }
  | { readonly toolCalls: readonly LoopToolCall[]; readonly reasoning?: string };

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
  readonly toolChoice?: { readonly type: string; readonly toolName?: string };
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
      imageParts: options.prompt.reduce((count, message) => count + (
        message.role === 'user' && typeof message.content !== 'string'
          ? message.content.filter((part) => part.type === 'image' || part.type === 'file').length
          : 0
      ), 0),
      lastPrompt: lastUserText(options.prompt),
      userMessages: options.prompt.filter((message) => message.role === 'user').length,
      toolResults,
      lastToolResult: toolResults[toolResults.length - 1] ?? '',
      system: options.prompt
        .filter((message) => message.role === 'system')
        .map(userText)
        .join('\n'),
      toolChoice:
        options.toolChoice === undefined
          ? 'auto'
          : options.toolChoice.type === 'tool'
            ? `tool:${options.toolChoice.toolName ?? ''}`
            : options.toolChoice.type,
    };
    loopCalls.push(call);
    const answer = respond(call);
    const toPart = (toolCall: LoopToolCall) => ({
      type: 'tool-call' as const,
      toolCallId: `scripted_${(callCounter += 1)}`,
      toolName: toolCall.toolName,
      input: JSON.stringify(toolCall.input),
    });
    if (Array.isArray(answer)) {
      return scriptedResult(answer.map(toPart), 'tool-calls');
    }
    const object = answer as
      | { readonly text: string; readonly reasoning?: string }
      | { readonly toolCalls: readonly LoopToolCall[]; readonly reasoning?: string };
    const reasoning =
      object.reasoning === undefined ? [] : [{ type: 'reasoning' as const, text: object.reasoning }];
    if ('toolCalls' in object) {
      return scriptedResult([...reasoning, ...object.toolCalls.map(toPart)], 'tool-calls');
    }
    return scriptedResult([...reasoning, { type: 'text' as const, text: object.text }], 'stop');
  });
}

function firstUserText(prompt: readonly RawMessage[]): string {
  const first = prompt.find((message) => message.role === 'user');
  return first === undefined ? '' : userText(first);
}

function lastUserText(prompt: readonly RawMessage[]): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]!;
    if (message.role === 'user') return userText(message);
  }
  return '';
}

function userText(message: RawMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text' && part.text !== undefined)
    .map((part) => part.text)
    .join('\n');
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

/**
 * Finds the observed node id on the first line matching a pattern. A tool
 * result in pixel mode is one JSON-encoded line (text beside an image), so
 * its escaped quotes and newlines are unescaped first.
 */
export function nodeIdFor(observedText: string, pattern: RegExp): string {
  for (const line of observedText.replaceAll('\\n', '\n').replaceAll('\\"', '"').split('\n')) {
    if (!pattern.test(line)) continue;
    const id = /#(\S+)/.exec(line)?.[1];
    if (id !== undefined) return id;
  }
  throw new Error(`no observed node matching ${String(pattern)} in:\n${observedText}`);
}

/**
 * A CSS-pixel point as the model would name it in the latest screenshot,
 * read off the `Screenshot attached` note the result carries: `(0.6 per CSS
 * pixel)` when the image is scaled, no note when it is not.
 */
export function imagePointFor(resultText: string, css: { readonly x: number; readonly y: number }): { x: number; y: number } {
  const scale = Number(/\((\d+(?:\.\d+)?) per CSS pixel\)/.exec(resultText)?.[1] ?? '1');
  return { x: Math.round(css.x * scale), y: Math.round(css.y * scale) };
}
