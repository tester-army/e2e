/**
 * `chatgpt('gpt-6-luna')`: a ChatGPT Plus/Pro subscription as an AI SDK
 * model. The instance is `@ai-sdk/openai`'s Responses model with a fetch that
 * carries the stored login; nothing is read until the first call. `e2e models
 * openai` lists the ids the plan serves.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { withLogin } from './login-model.ts';
import { USER_AGENT } from '../internal/client-identity.ts';
import { loginHint } from './providers.ts';
import { createCodexProvider } from './providers/openai.ts';
import { withoutServerStorage } from './responses.ts';
import { defaultCredentialStore } from './store.ts';

export function chatgpt(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createCodexProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('openai'),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  return withLogin(withoutServerStorage(createOpenAI({ apiKey: 'oauth', fetch, name: 'chatgpt' }).responses(modelId)), 'openai');
}
