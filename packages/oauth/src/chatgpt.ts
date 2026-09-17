/**
 * `chatgpt('gpt-5.5')`: a ChatGPT Plus/Pro subscription as an AI SDK model.
 * The instance is `@ai-sdk/openai`'s Responses model with a fetch that
 * carries the stored login; nothing is read until the first call.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, getDefaultStore, getProvider, loginHint } from './registry.ts';
import { createCodexProvider } from './providers/openai-codex.ts';
import type { CredentialStore, OAuthProvider } from './types.ts';

export interface ChatGptOptions {
  readonly store?: CredentialStore;
  readonly userAgent?: string;
  /** Where the Codex backend is reached, for a proxy in front of it. */
  readonly apiUrl?: string;
}

/** Models the Codex backend serves to subscription logins, as of September 2026. */
export const CHATGPT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'] as const;

export function chatgpt(modelId: string, options: ChatGptOptions = {}): LanguageModelV4 {
  const provider = options.apiUrl === undefined ? getProvider('openai-codex')! : (createCodexProvider({ apiUrl: options.apiUrl }) as OAuthProvider<never>);
  const fetch = createOAuthFetch(provider, {
    store: options.store ?? getDefaultStore(),
    userAgent: options.userAgent ?? USER_AGENT,
    loginHint: loginHint('openai-codex'),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  return createOpenAI({ apiKey: 'oauth', fetch, name: 'chatgpt' }).responses(modelId);
}
