/**
 * Provider request hints: what a request carries, per provider, so the
 * repeated prefix (system prompt, tool definitions, the conversation so far)
 * is served from the provider's cache, and so no turn depends on state the
 * provider kept.
 *
 * Anthropic caches only up to an explicit breakpoint, so the system prompt
 * carries one (it covers the tool definitions ahead of it) and the newest
 * message carries the other: the next turn's request then matches everything
 * up to it. OpenAI-shaped providers (OpenAI, Azure OpenAI) cache prefixes on
 * their own and take a routing key, one per system prompt, so every call of
 * a run addresses the same cache. Their requests also carry `store: false`:
 * the runner never reads a response back, and with storage on the AI SDK
 * replays a reasoning model's earlier turns by item id, which an organization
 * with zero data retention has never stored. Without storage the reasoning
 * travels inline as encrypted content and the cache still hits. Other
 * providers get nothing extra, and the request is exactly what it was.
 */

import { createHash } from 'node:crypto';
import type { ModelMessage, SystemModelMessage } from 'ai';
import type { ProviderOptions } from '../../types.ts';

/** What the hints read off a model: the provider and model id the SDK reports. */
export interface ProviderModelRef {
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
}

export interface ProviderHints {
  /** The system prompt as the request's instructions, carrying a breakpoint where the provider needs one. */
  instructions(system: string): string | SystemModelMessage;
  /**
   * Request-level provider options: the caller's own, plus a prompt-cache
   * routing key and `store: false` where the provider takes them. The
   * caller's values win.
   */
  providerOptions(base: ProviderOptions | undefined, system: string): ProviderOptions | undefined;
  /**
   * Moves the conversation breakpoint to the newest message. Every other
   * message loses its breakpoint, so a history that carries forward across
   * turns never accumulates more than the provider allows.
   */
  markLatest(messages: ModelMessage[]): ModelMessage[];
}

const ANTHROPIC_BREAKPOINT = { cacheControl: { type: 'ephemeral' } } as const;

/** The hints for one model; a no-op for providers without a cache the request can address. */
export function providerHints(model: ProviderModelRef | undefined): ProviderHints {
  const anthropic = speaksAnthropic(model);
  const openai = openaiOptionsKey(model);
  return {
    instructions: (system) =>
      anthropic ? { role: 'system', content: system, providerOptions: { anthropic: ANTHROPIC_BREAKPOINT } } : system,
    providerOptions: (base, system) =>
      openai === undefined
        ? base
        : { ...base, [openai]: { promptCacheKey: promptCacheKey(system), store: false, ...base?.[openai] } },
    markLatest: (messages) => (anthropic ? moveBreakpoint(messages) : messages),
  };
}

/**
 * A gateway model names its upstream in the model id (`anthropic/claude-…`);
 * a direct provider names it in the provider (`anthropic.messages`).
 */
function speaksAnthropic(model: ProviderModelRef | undefined): boolean {
  return idPrefix(model, 'anthropic/') || providerPrefix(model, 'anthropic');
}

/**
 * The provider-options key of an OpenAI-shaped model, which is how the AI
 * SDK keys them too: `openai` for OpenAI itself (`openai.responses`, or
 * `openai/gpt-…` through a gateway), `azure` for Azure OpenAI.
 */
function openaiOptionsKey(model: ProviderModelRef | undefined): 'openai' | 'azure' | undefined {
  if (idPrefix(model, 'openai/') || providerPrefix(model, 'openai')) return 'openai';
  if (providerPrefix(model, 'azure')) return 'azure';
  return undefined;
}

function idPrefix(model: ProviderModelRef | undefined, prefix: string): boolean {
  return (model?.modelId ?? '').toLowerCase().startsWith(prefix);
}

function providerPrefix(model: ProviderModelRef | undefined, prefix: string): boolean {
  return (model?.provider ?? '').toLowerCase().startsWith(prefix);
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
