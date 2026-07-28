/**
 * Scripted AI SDK model for agent tests. `installFakeModel` returns a real
 * `LanguageModelV2` instance that tests pass as `agent: { model }`, so every
 * test exercises the production adapter path — prompt assembly, structured
 * output, closed-grammar validation, repair, and budget accounting — without a
 * provider. Detection in config resolution is structural, so the instance
 * works across the src/dist realm boundary.
 */

import type { ModelInstance } from '../../src/types.ts';

export interface FakeCall {
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
}

export type FakeResponder = (call: FakeCall) => unknown;

/** Recorded calls, newest last. Cleared by every installFakeModel call. */
export const fakeCalls: FakeCall[] = [];

/** The structural surface the AI SDK reads from a V2 prompt message list. */
type FakePrompt = readonly {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string }[];
}[];

/**
 * Builds the scripted model. Configure tests with `agent: { model }`; the
 * instance never crosses a process boundary because agent integration tests
 * run through the in-process transport.
 */
export function installFakeModel(responder: FakeResponder): ModelInstance {
  fakeCalls.length = 0;
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate(options: {
      prompt: FakePrompt;
      responseFormat?: { type: string; name?: string } | undefined;
    }) {
      const system = promptText(options.prompt, 'system');
      const prompt = promptText(options.prompt, 'user');
      const observation = section(prompt, 'observation');
      const parsed: FakeCall = {
        schemaName: options.responseFormat?.name ?? inferSchemaName(prompt),
        system,
        prompt,
        instruction: section(prompt, 'instruction').trim(),
        observation,
        revision: /<observation revision="([^"]+)"/.exec(prompt)?.[1] ?? '',
        lines: observation.split('\n').filter((line) => line.trim() !== ''),
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
    if (score > 0 && !/\bgeneric\b/.test(haystack)) score += 0.5;
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

/** Builds a valid agent-locate-1 explicit no-match response. */
export function locateNotFound(explanation: string): unknown {
  return { protocolVersion: 'agent-locate-1', target: null, explanation };
}

/** Builds a valid agent-judgment-1 response. */
export function judgment(result: boolean, explanation: string): unknown {
  return { protocolVersion: 'agent-judgment-1', result, explanation };
}
