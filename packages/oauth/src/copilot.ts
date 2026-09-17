/**
 * `copilot('claude-sonnet-5')`: a GitHub Copilot subscription as an AI SDK
 * model. Copilot serves OpenAI, Anthropic, Google, and xAI models over the
 * OpenAI chat protocol; the instance is `@ai-sdk/openai-compatible`'s chat
 * model at the Copilot API with a fetch that carries the stored login.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { copilotBaseUrl, type CopilotCredentials } from './providers/github-copilot.ts';
import { USER_AGENT, getDefaultStore, getProvider, loginHint } from './registry.ts';
import type { CredentialStore } from './types.ts';

export interface CopilotOptions {
  readonly store?: CredentialStore;
  readonly userAgent?: string;
  /** GitHub Enterprise host; defaults to what the login stored, else github.com. */
  readonly enterpriseUrl?: string;
  /** Where the Copilot API is reached, for a proxy in front of it; overrides `enterpriseUrl`. */
  readonly baseURL?: string;
}

export function copilot(modelId: string, options: CopilotOptions = {}): LanguageModelV4 {
  const provider = getProvider('github-copilot')!;
  const store = options.store ?? getDefaultStore();
  const oauthFetch = createOAuthFetch(provider, {
    store,
    userAgent: options.userAgent ?? USER_AGENT,
    loginHint: loginHint('github-copilot'),
  });
  // The base URL is decided per request so an enterprise login stored later still routes right.
  const fetch: typeof oauthFetch = async (input, init) => {
    if (options.enterpriseUrl !== undefined || options.baseURL !== undefined) return oauthFetch(input, init);
    const stored = (await store.get('github-copilot')) as CopilotCredentials | undefined;
    if (stored?.enterpriseUrl === undefined) return oauthFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const rewritten = url.href.replace(PLACEHOLDER_BASE, copilotBaseUrl(stored.enterpriseUrl));
    return oauthFetch(input instanceof Request ? new Request(rewritten, input) : rewritten, init);
  };
  return createOpenAICompatible({
    name: 'github-copilot',
    baseURL: options.baseURL ?? (options.enterpriseUrl === undefined ? PLACEHOLDER_BASE : copilotBaseUrl(options.enterpriseUrl)),
    apiKey: 'oauth',
    fetch,
    includeUsage: true,
  }).chatModel(modelId);
}

const PLACEHOLDER_BASE = copilotBaseUrl();
