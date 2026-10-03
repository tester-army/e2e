/**
 * `copilot('claude-sonnet-5')`: a GitHub Copilot subscription as an AI SDK
 * model. Copilot serves most of its models over the OpenAI chat protocol and
 * some only over its Responses API; the instance asks the plan's model
 * listing which on the first call and delegates to the matching model, so
 * construction stays synchronous and touches the network only when a call
 * does. An enterprise login stored by `e2e login` routes to its own host.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { OAuthError } from './errors.ts';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT } from '../internal/client-identity.ts';
import { loginHint } from './providers.ts';
import { COPILOT_API_URL, copilotProtocolFor, createCopilotProvider, type CopilotProtocol } from './providers/github-copilot.ts';
import { withoutServerStorage } from './responses.ts';
import { defaultCredentialStore } from './store.ts';
import type { FetchFunction } from './types.ts';

/** How long the first call waits on the model listing before it calls over chat and asks again next time. */
const LISTING_TIMEOUT_MS = 10_000;

export function copilot(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createCopilotProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('github-copilot'),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  const chat = createOpenAICompatible({
    name: 'github-copilot',
    baseURL: COPILOT_API_URL,
    apiKey: 'oauth',
    fetch,
    includeUsage: true,
  }).chatModel(modelId);
  return protocolDelegate(
    chat,
    () => responsesModel(modelId, fetch),
    () => copilotProtocolFor(modelId, fetch, AbortSignal.timeout(LISTING_TIMEOUT_MS)),
  );
}

/**
 * The Responses model for `modelId`. `@ai-sdk/openai` is imported only here,
 * so a project that calls only chat models needs no install of it.
 */
async function responsesModel(modelId: string, fetch: FetchFunction): Promise<LanguageModelV4> {
  let createOpenAI: typeof import('@ai-sdk/openai').createOpenAI;
  try {
    ({ createOpenAI } = await import('@ai-sdk/openai'));
  } catch (cause) {
    throw new OAuthError(
      'MISCONFIGURED',
      `GitHub Copilot serves ${modelId} only over its Responses API, which copilot() calls through @ai-sdk/openai; install it beside @ai-sdk/openai-compatible`,
      { cause },
    );
  }
  return withoutServerStorage(createOpenAI({ apiKey: 'oauth', baseURL: COPILOT_API_URL, fetch, name: 'github-copilot' }).responses(modelId));
}

/**
 * A model that settles its Copilot protocol on the first call and delegates
 * to the model for it. One lookup serves every concurrent call, under its
 * own timeout, so a caller that gives up never fails the others. Only a
 * listing that was read is remembered: when it could not be read, that call
 * goes over chat, the endpoint most models use, and the next call asks again.
 */
function protocolDelegate(
  chat: LanguageModelV4,
  responses: () => Promise<LanguageModelV4>,
  lookup: () => Promise<CopilotProtocol | undefined>,
): LanguageModelV4 {
  let resolved: LanguageModelV4 | undefined;
  let pending: Promise<LanguageModelV4> | undefined;
  const settle = (): Promise<LanguageModelV4> => {
    if (resolved !== undefined) return Promise.resolve(resolved);
    pending ??= (async () => {
      const protocol = await lookup();
      if (protocol === undefined) return chat;
      resolved = protocol === 'responses' ? await responses() : chat;
      return resolved;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    specificationVersion: chat.specificationVersion,
    get provider() {
      return resolved?.provider ?? chat.provider;
    },
    get modelId() {
      return resolved?.modelId ?? chat.modelId;
    },
    get supportedUrls() {
      return resolved?.supportedUrls ?? chat.supportedUrls;
    },
    doGenerate: async (options) => (await untilAborted(settle(), options.abortSignal)).doGenerate(options),
    doStream: async (options) => (await untilAborted(settle(), options.abortSignal)).doStream(options),
  };
}

/** Waits for `promise` unless `signal` aborts first, leaving the shared promise running for other callers. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
