/**
 * `copilot('claude-sonnet-5')`: a GitHub Copilot subscription as an AI SDK
 * model. Copilot serves OpenAI, Anthropic, Google, and SpaceXAI models over the
 * OpenAI chat protocol; the instance is `@ai-sdk/openai-compatible`'s chat
 * model at the Copilot API with a fetch that carries the stored login. An
 * enterprise login stored by `e2e login` routes to its own host.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, loginHint } from './providers.ts';
import { COPILOT_API_URL, createCopilotProvider } from './providers/github-copilot.ts';
import { defaultCredentialStore } from './store.ts';
import type { CredentialStore } from './types.ts';

export interface CopilotOptions {
  readonly store?: CredentialStore;
  readonly userAgent?: string;
  /** Where the Copilot API is reached, for a proxy in front of it. */
  readonly baseURL?: string;
}

export function copilot(modelId: string, options: CopilotOptions = {}): LanguageModelV4 {
  const fetch = createOAuthFetch(createCopilotProvider(), {
    store: options.store ?? defaultCredentialStore(),
    userAgent: options.userAgent ?? USER_AGENT,
    loginHint: loginHint('github-copilot'),
  });
  return createOpenAICompatible({
    name: 'github-copilot',
    baseURL: options.baseURL ?? COPILOT_API_URL,
    apiKey: 'oauth',
    fetch,
    includeUsage: true,
  }).chatModel(modelId);
}
