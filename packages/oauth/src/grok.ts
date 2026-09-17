/**
 * `grok('grok-4')`: a SuperGrok or X Premium+ subscription as an AI SDK
 * model. The instance is `@ai-sdk/xai`'s model with a fetch that carries the
 * stored login; the API is the ordinary xAI API.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createXai } from '@ai-sdk/xai';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, loginHint } from './providers.ts';
import { createXaiProvider } from './providers/xai.ts';
import { defaultCredentialStore } from './store.ts';
import type { CredentialStore } from './types.ts';

export interface GrokOptions {
  readonly store?: CredentialStore;
  readonly userAgent?: string;
  /** Where the xAI API is reached, for a proxy in front of it. */
  readonly baseURL?: string;
}

export function grok(modelId: string, options: GrokOptions = {}): LanguageModelV4 {
  const fetch = createOAuthFetch(createXaiProvider(), {
    store: options.store ?? defaultCredentialStore(),
    userAgent: options.userAgent ?? USER_AGENT,
    loginHint: loginHint('xai'),
  });
  return createXai({ apiKey: 'oauth', fetch, ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }) })(modelId);
}
