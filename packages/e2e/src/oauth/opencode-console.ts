/**
 * `opencodeConsole('deepseek-v4.1-flash')`: an OpenCode Console workspace as
 * an AI SDK model, Zen for a bare id and Go for a `go/` one. The first call
 * reads the workspace config for the model's protocol and lazily loads the
 * SDK for it. Requests get the prompt-cache hints the runner itself adds for
 * OpenAI and Anthropic, which it cannot do here since the protocol is unknown
 * until then. `OPENCODE_API_KEY` replaces the stored login when set.
 */

import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Message } from '@ai-sdk/provider';
import { promptCacheKey } from '../agent/model/provider-hints.ts';
import { OAuthError } from './errors.ts';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT } from '../internal/client-identity.ts';
import { loginHint } from './providers.ts';
import { createOpencodeConsoleProvider, opencodeConsoleChatRoute, opencodeConsoleRouteFor, type OpencodeConsoleRoute } from './providers/opencode-console.ts';
import { EnvCredentialStore, defaultCredentialStore } from './store.ts';
import type { CredentialStore, FetchFunction } from './types.ts';

const CONFIG_TIMEOUT_MS = 10_000;
const API_KEY_ENV = 'OPENCODE_API_KEY';
/** The Anthropic SDK limits a model id it does not know to 4096 output tokens and only warns, so a caller that sets no cap is truncated in silence; ask for the runner's own cap instead. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const BREAKPOINT = { cacheControl: { type: 'ephemeral' } } as const;

interface Served {
  readonly npm: string;
  readonly model: LanguageModelV4;
}

export function opencodeConsole(modelId: string): LanguageModelV4 {
  const apiKey = process.env[API_KEY_ENV]?.trim();
  const fetch = createOAuthFetch(createOpencodeConsoleProvider(), {
    store: apiKey ? apiKeyStore(apiKey) : defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: apiKey ? `check ${API_KEY_ENV}` : loginHint('opencode-console'),
  });
  // One per model, so a worker's calls stay on one upstream and its cache.
  const session = `e2e_${randomUUID()}`;
  const chatRoute = opencodeConsoleChatRoute(modelId);
  const chat: Served = { npm: chatRoute.npm, model: chatModel(chatRoute, fetch, session) };
  let resolved: Served | undefined;
  let pending: Promise<Served> | undefined;

  // An unreadable config sends that call over chat and is asked again next time.
  const served = (): Promise<Served> => {
    if (resolved !== undefined) return Promise.resolve(resolved);
    pending ??= (async () => {
      const route = await opencodeConsoleRouteFor(modelId, fetch, AbortSignal.timeout(CONFIG_TIMEOUT_MS));
      if (route === undefined) return chat;
      resolved = { npm: route.npm, model: await sdkModel(route, fetch, session) };
      return resolved;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  // Fixed: the runner reads provider and modelId before and after the first call.
  return {
    specificationVersion: chat.model.specificationVersion,
    provider: chatRoute.go ? 'opencode.go' : 'opencode',
    modelId: chatRoute.modelId,
    get supportedUrls() {
      return (resolved ?? chat).model.supportedUrls;
    },
    async doGenerate(options) {
      const { npm, model } = await served();
      return model.doGenerate(requestFor(npm, options, session));
    },
    async doStream(options) {
      const { npm, model } = await served();
      return model.doStream(requestFor(npm, options, session));
    },
  };
}

/** A Console service API key as a login with nothing to refresh. */
function apiKeyStore(apiKey: string): CredentialStore {
  return new EnvCredentialStore(JSON.stringify({ 'opencode-console': { access: apiKey, refresh: '', expires: 0 } }));
}

/** `opencode.go` keeps Go's provider options under `opencode`, the name up to the first dot; `apiKey` only satisfies the constructors. */
function settings(route: OpencodeConsoleRoute, fetch: FetchFunction, session: string) {
  return { name: route.go ? 'opencode.go' : 'opencode', baseURL: route.baseURL, apiKey: 'oauth', fetch, headers: { 'x-opencode-session': session } };
}

function chatModel(route: OpencodeConsoleRoute, fetch: FetchFunction, session: string): LanguageModelV4 {
  return createOpenAICompatible({ ...settings(route, fetch, session), includeUsage: true }).chatModel(route.modelId);
}

async function sdkModel(route: OpencodeConsoleRoute, fetch: FetchFunction, session: string): Promise<LanguageModelV4> {
  switch (route.npm) {
    case '@ai-sdk/openai': {
      const { createOpenAI } = await load(() => import('@ai-sdk/openai'), route);
      return createOpenAI(settings(route, fetch, session)).responses(route.modelId);
    }
    case '@ai-sdk/anthropic': {
      const { createAnthropic } = await load(() => import('@ai-sdk/anthropic'), route);
      return createAnthropic(settings(route, fetch, session))(route.modelId);
    }
    case '@ai-sdk/google': {
      const { createGoogleGenerativeAI } = await load(() => import('@ai-sdk/google'), route);
      return createGoogleGenerativeAI(settings(route, fetch, session))(route.modelId);
    }
    default:
      return chatModel(route, fetch, session);
  }
}

/** Responses: no server storage and the runner's prompt cache key. Anthropic: cache breakpoints. */
function requestFor(npm: string, options: LanguageModelV4CallOptions, session: string): LanguageModelV4CallOptions {
  switch (npm) {
    case '@ai-sdk/openai': {
      const system = options.prompt.flatMap((message) => (message.role === 'system' ? [message.content] : [])).join('\n');
      const cacheKey = system === '' ? session : promptCacheKey(system);
      return { ...options, providerOptions: { ...options.providerOptions, openai: { promptCacheKey: cacheKey, ...options.providerOptions?.['openai'], store: false } } };
    }
    case '@ai-sdk/anthropic':
      return { ...options, maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, prompt: withBreakpoints(options.prompt, (options.tools?.length ?? 0) > 0) };
    default:
      return options;
  }
}

/**
 * The system prompt, and in a tool loop the newest message, as the runner
 * marks them; a call without tools is a one-off judgment. A prompt that already
 * carries a breakpoint is left as the caller placed it.
 */
function withBreakpoints(prompt: LanguageModelV4CallOptions['prompt'], loop: boolean): LanguageModelV4CallOptions['prompt'] {
  if (prompt.some(hasBreakpoint)) return prompt;
  const marked = new Set([prompt.findLastIndex((message) => message.role === 'system'), loop ? prompt.length - 1 : -1]);
  return prompt.map((message, index) =>
    marked.has(index) ? ({ ...message, providerOptions: { ...message.providerOptions, anthropic: { ...message.providerOptions?.['anthropic'], ...BREAKPOINT } } } as LanguageModelV4Message) : message,
  );
}

function hasBreakpoint(message: LanguageModelV4Message): boolean {
  const marked = (providerOptions: LanguageModelV4Message['providerOptions']) => providerOptions?.['anthropic']?.['cacheControl'] !== undefined;
  return marked(message.providerOptions) || (Array.isArray(message.content) && message.content.some((part) => marked(part.providerOptions)));
}

/** Names the missing package when an SDK is not installed. */
async function load<Module>(importer: () => Promise<Module>, route: OpencodeConsoleRoute): Promise<Module> {
  try {
    return await importer();
  } catch (cause) {
    throw new OAuthError('MISCONFIGURED', `OpenCode Console serves ${route.modelId} through ${route.npm}, which opencodeConsole() loads on demand; install it beside @ai-sdk/openai-compatible`, { cause });
  }
}
