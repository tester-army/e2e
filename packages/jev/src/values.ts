/**
 * Where typed text comes from when the brain cannot write any.
 *
 * Jev returns a choice, never a string. A `type` action therefore needs its
 * value enumerated first: the literals the step quotes, the step's string
 * parameters, and the values a previous turn already typed are the candidates,
 * and Jev picks among them. A step that names no literal ("a todo of your
 * choice", "today's date") has nothing to pick from; a generative fallback
 * writes that one value, or the step fails with a reason a reader can act on.
 */

import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

/** The literals a step spells out, in order of appearance, deduplicated. */
export function literalsOf(instruction: string, params: Readonly<Record<string, unknown>> | undefined): string[] {
  const found: string[] = [];
  for (const match of instruction.matchAll(/["“”']([^"“”']{1,200})["“”']/g)) {
    const literal = match[1];
    if (literal !== undefined) found.push(literal);
  }
  // Back-ticked and unquoted values a test passes as params are literals too.
  for (const value of Object.values(params ?? {})) {
    if (typeof value === 'string' && value !== '') found.push(value);
    if (typeof value === 'number') found.push(String(value));
  }
  return [...new Set(found)];
}

export interface GeneratedValue {
  readonly value: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly durationMs: number;
  readonly modelId: string;
}

/**
 * Asks the generative fallback for the one string the step needs in a field.
 * Kept to a single short completion: Jev already decided which field and that
 * typing is the right move; the fallback only writes the text.
 */
export async function generateValue(
  model: LanguageModel,
  input: { readonly instruction: string; readonly field: string; readonly screen: string; readonly history: readonly string[] },
  signal: AbortSignal,
): Promise<GeneratedValue> {
  const started = performance.now();
  const result = await generateText({
    model,
    abortSignal: signal,
    maxOutputTokens: 120,
    prompt: [
      'You are typing into one form field for a test step. Reply with the exact text to type and nothing else: no quotes, no explanation.',
      `Step: ${input.instruction}`,
      `Field: ${input.field}`,
      input.history.length > 0 ? `Actions so far:\n${input.history.join('\n')}` : '',
      `Screen:\n${input.screen}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n'),
  });
  const modelId = typeof model === 'string' ? model : model.modelId;
  return {
    value: result.text.trim().replace(/^["'`]+|["'`]+$/g, ''),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: Math.round(performance.now() - started),
    modelId,
  };
}
