/**
 * Provider request hints: what a request carries, per provider, so the
 * repeated prefix (system prompt, tool definitions, the conversation so far)
 * is served from the provider's cache, and so no turn depends on state the
 * provider kept.
 *
 * Anthropic caches only up to an explicit breakpoint, so the system prompt
 * carries one (it covers the tool definitions ahead of it) and the newest
 * message carries the other: the next turn's request then matches everything
 * up to it. OpenAI Responses models (OpenAI, Azure OpenAI, and OpenAI through
 * the gateway) cache prefixes on their own and take a routing key, one per
 * system prompt, so every call of a run addresses the same cache. Their
 * requests also carry `store: false`:
 * the runner never reads a response back, and with storage on the AI SDK
 * replays a reasoning model's earlier turns by item id, which an organization
 * with zero data retention has never stored. Without storage the reasoning
 * travels inline as encrypted content and the cache still hits. Other
 * providers get nothing extra, and the request is exactly what it was.
 *
 * Anthropic also binds every thinking block to the prefix that produced it
 * (the system prompt and every message before the block; a changed tool
 * list passed the check when tried) and rejects a replayed block whose
 * prefix changed. The loop keeps the system prompt of a step fixed; when it
 * rewrites an earlier message (a superseded screen or screenshot elided, a
 * history shrunk), the reasoning from that message on is left out of the
 * next request.
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
  /**
   * The history to send once the message at `index` was rewritten since the
   * last request. Where the provider binds reasoning to the prefix, the
   * reasoning parts from that message on are left out: text and tool calls
   * stay, and a reply that was only reasoning goes. Dropping thinking from
   * the end of a history is allowed, dropping it from the middle is not,
   * which is why everything after the edit goes. Returns the input array
   * when nothing is dropped.
   */
  afterEdit(messages: ModelMessage[], index: number): ModelMessage[];
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
    afterEdit: (messages, index) => (anthropic ? withoutReasoningFrom(messages, index) : messages),
  };
}

/**
 * A gateway or OpenRouter model names its upstream in the model id
 * (`anthropic/claude-…`), a direct provider in the provider
 * (`anthropic.messages`), Vertex AI in the provider too
 * (`vertex.anthropic.messages`), and Bedrock in the model id behind an
 * optional region prefix (`eu.anthropic.claude-…`). A Bedrock application
 * inference profile ARN names no model and is not recognized.
 */
function speaksAnthropic(model: ProviderModelRef | undefined): boolean {
  if (idPrefix(model, 'anthropic/') || providerPrefix(model, 'anthropic')) return true;
  const provider = (model?.provider ?? '').toLowerCase();
  const id = (model?.modelId ?? '').toLowerCase();
  return provider.includes('.anthropic') || /(?:^|\.)anthropic\.claude/.test(id);
}

/**
 * The provider-options key of an OpenAI Responses model, which is how the AI
 * SDK keys them too: `openai` for OpenAI itself (`openai.responses`, or
 * `openai/gpt-…` through the gateway), `azure` for Azure OpenAI. Chat models
 * get none: an OpenAI-compatible provider named `openai` reports `openai.chat`
 * like OpenAI's own chat model, but copies the options into the request body
 * as they are, which the endpoint rejects.
 */
function openaiOptionsKey(model: ProviderModelRef | undefined): 'openai' | 'azure' | undefined {
  const provider = (model?.provider ?? '').toLowerCase();
  if (provider === 'gateway') return idPrefix(model, 'openai/') ? 'openai' : undefined;
  if (!provider.endsWith('.responses')) return undefined;
  if (provider.includes('azure')) return 'azure';
  return provider.startsWith('openai') ? 'openai' : undefined;
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

/** The history without the reasoning parts of the assistant messages at or after `index`. */
function withoutReasoningFrom(messages: ModelMessage[], index: number): ModelMessage[] {
  let changed = false;
  const next = messages.flatMap((message, position) => {
    if (position < index || message.role !== 'assistant' || typeof message.content === 'string') return [message];
    const content = message.content.filter((part) => part.type !== 'reasoning');
    if (content.length === message.content.length) return [message];
    changed = true;
    return content.length === 0 ? [] : [{ ...message, content }];
  });
  return changed ? next : messages;
}
