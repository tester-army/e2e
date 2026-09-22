/**
 * `grok('grok-4')`: a SuperGrok or X Premium+ subscription as an AI SDK
 * model. The instance is `@ai-sdk/xai`'s model with a fetch that carries the
 * stored login; the API is the ordinary SpaceXAI API.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createXai } from '@ai-sdk/xai';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, loginHint } from './providers.ts';
import { createXaiProvider } from './providers/xai.ts';
import { defaultCredentialStore } from './store.ts';

export function grok(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createXaiProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('spacexai'),
  });
  return createXai({ apiKey: 'oauth', fetch })(modelId);
}
