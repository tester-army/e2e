/**
 * The emitted declarations are the public API. `tests/types/sdk-types.ts`
 * pins the removals against `src/`; this pins them against what the package
 * ships, so a re-export that creeps back through a barrel or a type alias
 * fails here even when the source assertions still hold.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** One built declaration file, read as text. */
function declaration(relative: string): string {
  return readFileSync(new URL(`../../dist/${relative}`, import.meta.url), 'utf8');
}

/** Whether `text` mentions `name` as a whole word, in an export list or anywhere else. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, 'u').test(text);
}

describe('the built declarations', () => {
  it('export nothing outside the runner consumed from e2e', () => {
    const index = declaration('index.d.ts');
    expect(mentions(index, 'renderMarkdownReport')).toBe(true);
    for (const name of ['BLOCKABLE_CODES', 'RUNTIME_CODES', 'buildTraceEntry', 'readTraceEntry']) {
      expect(mentions(index, name), name).toBe(false);
    }
  });

  it('export nothing outside the runner consumed from e2e/agent', () => {
    const agent = declaration('agent/public.d.ts');
    expect(mentions(agent, 'defineTool')).toBe(true);
    for (const name of ['isDefinedTool', 'toolAppliesTo', 'createAgent', 'CreateAgentOptions', 'DefaultAgent']) {
      expect(mentions(agent, name), name).toBe(false);
    }
  });

  it.each([
    ['oauth/chatgpt.d.ts', 'chatgpt', 'ChatGptOptions'],
    ['oauth/copilot.d.ts', 'copilot', 'CopilotOptions'],
    ['oauth/grok.d.ts', 'grok', 'GrokOptions'],
    ['oauth/orcarouter.d.ts', 'orcarouter', 'OrcaRouterOptions'],
    ['oauth/orcarouter-auth.d.ts', 'orcarouterAuth', 'OrcaRouterAuthOptions'],
  ])('%s declares a constructor of the model id alone', (file, constructor, options) => {
    const text = declaration(file);
    expect(text).toMatch(new RegExp(`export declare function ${constructor}\\(modelId: string\\): LanguageModelV4;`, 'u'));
    expect(mentions(text, options), options).toBe(false);
    expect(mentions(text, 'CredentialStore')).toBe(false);
  });
});
