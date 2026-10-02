/**
 * The one model factory both OrcaRouter entries share. It is the seam the
 * credential interface sits on: the fetch reads whichever key the user
 * obtained, and the model instance, the base URL, and the model catalog are
 * identical either way. Nothing downstream can tell a pasted key from one
 * minted by the sign-in flow, and no entry point copies the authentication
 * logic.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { orcaRouterOrigins } from './orcarouter-origins.ts';
import { API_KEY_PROVIDER_ID, AUTH_PROVIDER_ID } from './providers/orcarouter.ts';
import { USER_AGENT, getProvider, loginHint } from './providers.ts';
import { defaultCredentialStore } from './store.ts';

export function orcaRouterModel(providerId: typeof API_KEY_PROVIDER_ID | typeof AUTH_PROVIDER_ID, modelId: string): LanguageModelV4 {
  const provider = getProvider(providerId);
  const fetch = createOAuthFetch(provider, {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint(providerId),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  return createOpenAICompatible({
    name: 'orcarouter',
    baseURL: orcaRouterOrigins().api,
    apiKey: 'oauth',
    fetch,
    includeUsage: true,
  }).chatModel(modelId);
}
