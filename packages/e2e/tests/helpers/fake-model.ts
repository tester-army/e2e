/**
 * Scripted AI SDK model for agent tests. `installFakeModel` returns a real
 * `LanguageModelV2` instance that tests pass as `agent: { model }`, so every
 * test exercises the production adapter path — prompt assembly, structured
 * output, closed-grammar validation, repair, and budget accounting — without a
 * provider. Detection in config resolution is structural, so the instance
 * works across the src/dist realm boundary.
 */

import type { ModelInstance } from '../../src/types.ts';
import { createScriptedInstance, scriptedResult } from './scripted-model.ts';

/**
 * Applies the request schema to a scripted answer the way a strict provider
 * does: a property the schema does not declare is dropped, because
 * `additionalProperties` is false.
 *
 * Without this, a fake could answer with fields the runner never actually asked
 * the model for, and a schema that forgot to declare one would look fine in
 * every test while being stripped from every real response. That is exactly how
 * the locate `positional` hint went missing and left the cache permanently cold.
 */
function enforceRequestSchema(answer: unknown, schema: unknown): unknown {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    Array.isArray(answer) ||
    typeof schema !== 'object' ||
    schema === null
  ) {
    return answer;
  }
  const shape = schema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
  if (shape.additionalProperties !== false || shape.properties === undefined) return answer;
  const declared = new Set(Object.keys(shape.properties));
  return Object.fromEntries(
    Object.entries(answer as Record<string, unknown>).filter(([key]) => declared.has(key)),
  );
}

export interface FakeCall {
  /** Model instance that received the call. */
  readonly modelId: string;
  readonly schemaName: string;
  readonly system: string;
  readonly prompt: string;
  /** Content of the `<instruction>` section. */
  readonly instruction: string;
  /** Content of the `<observation>` section. */
  readonly observation: string;
  /** Observation revision advertised in the prompt. */
  readonly revision: string;
  /** Serialized observation lines, one per node. */
  readonly lines: readonly string[];
  /** Image parts attached to the user message, in order. */
  readonly images: readonly FakeImage[];
  /** Generation settings the adapter sent alongside the prompt. */
  readonly settings: FakeSettings;
}

/** The call settings a provider reads off a generate request. */
export interface FakeSettings {
  readonly maxOutputTokens: number | undefined;
  readonly temperature: number | undefined;
  readonly providerOptions: unknown;
}

/** One attached image, as the adapter handed it to the provider. */
export interface FakeImage {
  readonly mediaType: string | undefined;
  readonly bytes: number;
}

export type FakeResponder = (call: FakeCall) => unknown;

/** Recorded calls, newest last. Cleared by every installFakeModel call. */
export const fakeCalls: FakeCall[] = [];

/** The structural surface the AI SDK reads from a V2 prompt message list. */
type FakePart = {
  readonly type: string;
  readonly text?: string;
  readonly data?: unknown;
  readonly mediaType?: string;
};

type FakePrompt = readonly {
  readonly role: string;
  readonly content: string | readonly FakePart[];
}[];

/**
 * Builds the scripted model and clears the call log. Configure tests with
 * `agent: { model }`; the instance never crosses a process boundary because
 * agent integration tests run through the in-process transport.
 */
export function installFakeModel(
  responder: FakeResponder,
  options: { modelId?: string } = {},
): ModelInstance {
  fakeCalls.length = 0;
  const modelId = options.modelId ?? 'scripted';
  return createScriptedInstance(
    'fake',
    modelId,
    async (request: {
      prompt: FakePrompt;
      responseFormat?: { type: string; name?: string; schema?: unknown } | undefined;
      maxOutputTokens?: number | undefined;
      temperature?: number | undefined;
      providerOptions?: unknown;
    }) => {
      const system = promptText(request.prompt, 'system');
      const prompt = promptText(request.prompt, 'user');
      const observation = section(prompt, 'observation');
      const parsed: FakeCall = {
        modelId,
        schemaName: request.responseFormat?.name ?? inferSchemaName(prompt),
        system,
        prompt,
        instruction: section(prompt, 'instruction').trim(),
        observation,
        revision: promptRevision(prompt),
        lines: observation.split('\n').filter((line) => line.trim() !== ''),
        images: promptImages(request.prompt),
        settings: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          providerOptions: request.providerOptions,
        },
      };
      fakeCalls.push(parsed);
      const raw = enforceRequestSchema(responder(parsed), request.responseFormat?.schema);
      return scriptedResult([{ type: 'text' as const, text: JSON.stringify(raw) }], 'stop');
    },
  );
}


/** Concatenates the text of every prompt message with the given role. */
function promptText(prompt: FakePrompt, role: string): string {
  const parts: string[] = [];
  for (const message of prompt) {
    if (message.role !== role) continue;
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text' && part.text !== undefined) parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/**
 * The observation revision the request quotes.
 *
 * A pixels-only request carries no `<observation>` element, so the revision
 * travels with the screenshot description instead — a target still has to quote
 * it, which is what makes a stale answer detectable.
 */
function promptRevision(prompt: string): string {
  const tree = /<observation revision="([^"]+)"/.exec(prompt)?.[1];
  if (tree !== undefined) return tree;
  return /observation revision is "([^"]+)"/.exec(prompt)?.[1] ?? '';
}

/**
 * Collects every image part of the user message. The AI SDK normalizes an
 * `image` part into a `file` part carrying bytes, so both spellings count.
 */
function promptImages(prompt: FakePrompt): FakeImage[] {
  const images: FakeImage[] = [];
  for (const message of prompt) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'image' && part.type !== 'file') continue;
      images.push({ mediaType: part.mediaType, bytes: byteLength(part.data) });
    }
  }
  return images;
}

/** Unwraps the AI SDK's normalized `{ type: 'data', data }` file payload. */
function byteLength(data: unknown): number {
  if (data instanceof Uint8Array) return data.byteLength;
  if (typeof data === 'string') return data.length;
  if (typeof data === 'object' && data !== null && 'data' in data) {
    return byteLength((data as { data: unknown }).data);
  }
  return 0;
}

/**
 * Text-mode requests (extraction against a caller schema with no JSON Schema
 * projection) carry no provider schema name; the runner's request line is the
 * stable signal that identifies them.
 */
function inferSchemaName(prompt: string): string {
  return prompt.startsWith('Extract the requested data') ? 'agent-extract-1' : '';
}

/** Extracts one fenced prompt section. */
function section(prompt: string, name: string): string {
  const pattern = new RegExp(`<${name}[^>]*>\\n([\\s\\S]*?)\\n</${name}>`);
  return pattern.exec(prompt)?.[1] ?? '';
}

/**
 * Builds a valid agent-judgment-2 response. A boolean maps onto the two
 * product verdicts; pass `'inconclusive'` for the third.
 */
export function judgment(result: boolean | 'inconclusive', explanation: string): unknown {
  const verdict = result === 'inconclusive' ? 'inconclusive' : result ? 'holds' : 'fails';
  return { protocolVersion: 'agent-judgment-2', verdict, explanation };
}

