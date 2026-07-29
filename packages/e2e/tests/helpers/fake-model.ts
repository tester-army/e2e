/**
 * Scripted AI SDK model for agent tests. `installFakeModel` returns a real
 * `LanguageModelV2` instance that tests pass as `agent: { model }`, so every
 * test exercises the production adapter path — prompt assembly, structured
 * output, closed-grammar validation, repair, and budget accounting — without a
 * provider. Detection in config resolution is structural, so the instance
 * works across the src/dist realm boundary.
 */

import { observedLineHasRole } from '../../src/agent/observation.ts';
import type { ModelInstance } from '../../src/types.ts';

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
  return createFakeModel(responder, options);
}

/**
 * Builds one more scripted model sharing the same call log, for tests that pin
 * a second model such as `agent.visionModel`.
 */
export function createFakeModel(
  responder: FakeResponder,
  instance: { modelId?: string } = {},
): ModelInstance {
  const modelId = instance.modelId ?? 'scripted';
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId,
    supportedUrls: {},
    async doGenerate(options: {
      prompt: FakePrompt;
      responseFormat?: { type: string; name?: string } | undefined;
    }) {
      const system = promptText(options.prompt, 'system');
      const prompt = promptText(options.prompt, 'user');
      const observation = section(prompt, 'observation');
      const parsed: FakeCall = {
        modelId,
        schemaName: options.responseFormat?.name ?? inferSchemaName(prompt),
        system,
        prompt,
        instruction: section(prompt, 'instruction').trim(),
        observation,
        revision: promptRevision(prompt),
        lines: observation.split('\n').filter((line) => line.trim() !== ''),
        images: promptImages(options.prompt),
      };
      fakeCalls.push(parsed);
      const raw = responder(parsed);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(raw) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
          totalTokens: 120,
        },
        warnings: [],
      };
    },
    async doStream(): Promise<never> {
      throw new Error('the scripted fake model does not stream');
    },
    // The runner duck-types model instances exactly like the AI SDK does; the
    // structural fields above are the whole contract this fake relies on.
  } as ModelInstance;
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

/** Picks the observed node whose serialized line best matches the instruction. */
export function bestMatch(call: FakeCall): { id: string; line: string } {
  const words = call.instruction
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .filter((word) => word.length > 2);
  let best: { id: string; line: string; score: number } | undefined;
  for (const line of call.lines) {
    const id = /#(\S+)/.exec(line)?.[1];
    if (id === undefined) continue;
    const haystack = line.toLowerCase();
    let score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
    // Prefer semantic controls over plain text holders on equal word overlap.
    if (score > 0 && observedLineHasRole(line)) score += 0.5;
    if (best === undefined || score > best.score) best = { id, line, score };
  }
  if (best === undefined) throw new Error(`no observed nodes in prompt:\n${call.prompt}`);
  return { id: best.id, line: best.line };
}

/** Builds a valid agent-locate-1 response for the best-matching node. */
export function locateBestMatch(call: FakeCall): unknown {
  const match = bestMatch(call);
  return {
    protocolVersion: 'agent-locate-1',
    target: { id: match.id, revision: call.revision },
    explanation: `best line match: ${match.line.trim()}`,
  };
}

/**
 * Builds a locate response naming the nth observed node matching a predicate, for
 * pages where several nodes are identical and the choice has to be deliberate.
 */
export function locateNth(call: FakeCall, matches: RegExp, nth: number): unknown {
  const ids = call.lines
    .filter((line) => matches.test(line))
    .map((line) => /#(\S+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  const id = ids[nth];
  if (id === undefined) {
    throw new Error(`no node ${nth} matching ${String(matches)} among ${ids.length}`);
  }
  return {
    protocolVersion: 'agent-locate-1',
    target: { id, revision: call.revision },
    explanation: `deliberately the node at index ${nth}`,
  };
}

/** Builds a valid agent-locate-1 point response in the attached image space. */
export function locatePoint(
  call: FakeCall,
  point: { x: number; y: number },
  explanation = 'drawn there in the screenshot',
): unknown {
  return {
    protocolVersion: 'agent-locate-1',
    target: { point, revision: call.revision },
    explanation,
  };
}

/** Builds a valid agent-locate-1 explicit no-match response. */
export function locateNotFound(explanation: string): unknown {
  return { protocolVersion: 'agent-locate-1', target: null, explanation };
}

/** Builds a valid agent-judgment-1 response. */
export function judgment(result: boolean, explanation: string): unknown {
  return { protocolVersion: 'agent-judgment-1', result, explanation };
}
