/**
 * `chatgpt('gpt-6-luna')`: a ChatGPT Plus/Pro subscription as an AI SDK
 * model. The instance is `@ai-sdk/openai`'s Responses model with a fetch that
 * carries the stored login; nothing is read until the first call. `e2e models
 * openai` lists the ids the plan serves.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, loginHint } from './providers.ts';
import { createCodexProvider } from './providers/openai.ts';
import { defaultCredentialStore } from './store.ts';

export function chatgpt(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createCodexProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('openai'),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  return withoutServerStorage(createOpenAI({ apiKey: 'oauth', fetch, name: 'chatgpt' }).responses(modelId));
}

/**
 * Tells the SDK what the Codex backend enforces: nothing is stored server
 * side. Believing storage is on, the SDK refers back to an earlier turn's
 * reasoning by id (`item_reference`), which the backend then cannot find; told
 * it is off, the SDK carries the encrypted reasoning itself.
 */
function withoutServerStorage(model: LanguageModelV4): LanguageModelV4 {
  const storeOff = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    providerOptions: { ...options.providerOptions, openai: { ...options.providerOptions?.['openai'], store: false } },
  });
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doGenerate: (options) => model.doGenerate(storeOff(options)),
    doStream: (options) => model.doStream(storeOff(options)),
  };
}
