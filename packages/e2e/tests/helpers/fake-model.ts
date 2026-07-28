/**
 * Registers a scripted model adapter so agent tests exercise the real
 * observation, protocol, locate, and driver path without a provider.
 *
 * The built registry is used because integration tests drive the built runner.
 */

import type { ModelCall, ModelResult } from '../../src/agent/model/adapter.ts';

const builtRegistryModule = '../../dist/agent/model/registry.js';
const { registerModelAdapter } = (await import(
  builtRegistryModule
)) as typeof import('../../src/agent/model/registry.ts');

const builtAdapterModule = '../../dist/agent/model/adapter.js';
const { ModelOutputInvalidError } = (await import(
  builtAdapterModule
)) as typeof import('../../src/agent/model/adapter.ts');

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

/**
 * Installs the responder behind provider `fake`. Configure tests with
 * `agent: { model: 'fake/scripted' }`.
 */
export function installFakeModel(responder: FakeResponder): void {
  fakeCalls.length = 0;
  registerModelAdapter('fake', () => ({
    provenance: {
      provider: 'fake',
      model: 'scripted',
      endpoint: 'local',
      adapterVersion: 'fake/1.0.0',
    },
    async generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>> {
      const observation = section(call.prompt, 'observation');
      const parsed: FakeCall = {
        schemaName: call.schemaName,
        system: call.system,
        prompt: call.prompt,
        instruction: section(call.prompt, 'instruction').trim(),
        observation,
        revision: /<observation revision="([^"]+)"/.exec(call.prompt)?.[1] ?? '',
        lines: observation.split('\n').filter((line) => line.trim() !== ''),
      };
      fakeCalls.push(parsed);
      const raw = responder(parsed);
      const validation = call.validate(raw);
      if (!validation.ok) {
        // Mirrors the real adapter so repair and budget semantics are exercised.
        throw new ModelOutputInvalidError(validation.issue, { rawText: JSON.stringify(raw) });
      }
      return {
        value: validation.value,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          accounting: 'provider',
          estimatedCostUsd: undefined,
        },
      };
    },
  }));
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
