/**
 * Prompt-cache hints: what a request carries so the provider can serve the
 * repeated prefix (system prompt, tool definitions, the conversation so far)
 * from its cache instead of reading it again at full price.
 *
 * Anthropic caches only up to an explicit breakpoint, so the system prompt
 * carries one (it covers the tool definitions ahead of it) and the newest
 * message carries the other: the next turn's request then matches everything
 * up to it. OpenAI caches prefixes on its own and takes a routing key; one
 * key per system prompt sends every call of a run to the same cache. Other
 * providers get nothing extra, and the request is exactly what it was.
 */

import { createHash } from 'node:crypto';
import type { ModelMessage, SystemModelMessage } from 'ai';
import type { ProviderOptions } from '../../types.ts';

export type CacheFamily = 'anthropic' | 'openai';

/** What the hints need to know about the model: the provider and model id the SDK reports. */
export interface CacheModelRef {
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
}

/**
 * The provider family a model routes to. A gateway model names its upstream
 * in the model id (`anthropic/claude-…`); a direct provider names it in the
 * provider (`anthropic.messages`, `openai.responses`).
 */
export function cacheFamily(model: CacheModelRef | undefined): CacheFamily | undefined {
  const provider = (model?.provider ?? '').toLowerCase();
  const modelId = (model?.modelId ?? '').toLowerCase();
  if (modelId.startsWith('anthropic/') || provider.startsWith('anthropic')) return 'anthropic';
  if (modelId.startsWith('openai/') || provider.startsWith('openai')) return 'openai';
  return undefined;
}

const ANTHROPIC_BREAKPOINT = { cacheControl: { type: 'ephemeral' } } as const;

export interface PromptCacheHints {
  readonly family: CacheFamily | undefined;
  /** The system prompt as the request's instructions, carrying a breakpoint where the provider needs one. */
  instructions(system: string): string | SystemModelMessage;
  /**
   * Request-level provider options: the caller's own, plus a prompt-cache
   * routing key where the provider takes one. The caller's values win.
   */
  providerOptions(base: ProviderOptions | undefined, system: string): ProviderOptions | undefined;
  /**
   * Moves the conversation breakpoint to the newest message. Every other
   * message loses its breakpoint, so a history that carries forward across
   * turns never accumulates more than the provider allows.
   */
  markLatest(messages: ModelMessage[]): ModelMessage[];
}

/** The hints for one model; a no-op for providers without a cache the request can address. */
export function promptCacheHints(model: CacheModelRef | undefined): PromptCacheHints {
  const family = cacheFamily(model);
  return {
    family,
    instructions: (system) =>
      family === 'anthropic'
        ? { role: 'system', content: system, providerOptions: { anthropic: ANTHROPIC_BREAKPOINT } }
        : system,
    providerOptions: (base, system) => {
      if (family !== 'openai') return base;
      return {
        ...base,
        openai: { promptCacheKey: promptCacheKey(system), ...base?.['openai'] },
      };
    },
    markLatest: (messages) => (family === 'anthropic' ? moveBreakpoint(messages) : messages),
  };
}

/** A stable key for one system prompt, so every call sharing the prefix routes alike. */
export function promptCacheKey(system: string): string {
  return `e2e-${createHash('sha256').update(system).digest('hex').slice(0, 16)}`;
}

function moveBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages.length - 1;
  return messages.map((message, index) => (index === last ? withBreakpoint(message) : withoutBreakpoint(message)));
}

function withBreakpoint(message: ModelMessage): ModelMessage {
  const anthropic = message.providerOptions?.['anthropic'];
  return {
    ...message,
    providerOptions: { ...message.providerOptions, anthropic: { ...anthropic, ...ANTHROPIC_BREAKPOINT } },
  };
}

function withoutBreakpoint(message: ModelMessage): ModelMessage {
  const anthropic = message.providerOptions?.['anthropic'];
  if (anthropic === undefined || !('cacheControl' in anthropic)) return message;
  const { cacheControl: _dropped, ...rest } = anthropic;
  const { anthropic: _anthropic, ...others } = message.providerOptions ?? {};
  const providerOptions = Object.keys(rest).length === 0 ? others : { ...others, anthropic: rest };
  if (Object.keys(providerOptions).length === 0) {
    const { providerOptions: _none, ...bare } = message;
    return bare as ModelMessage;
  }
  return { ...message, providerOptions };
}
