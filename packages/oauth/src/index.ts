/**
 * Sign in to a personal AI subscription once, then use it as an AI SDK model.
 *
 * Model constructors live on subpaths so a config installs only the provider
 * package it uses: `@e2edev/oauth/chatgpt`, `@e2edev/oauth/copilot`,
 * `@e2edev/oauth/grok`. This entry holds the flows, the store, and the fetch
 * for anyone wiring a provider of their own.
 */

export type {
  CredentialStore,
  FetchFunction,
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProvider,
  PreparedRequest,
} from './types.ts';
export { OAuthError, type OAuthErrorCode } from './errors.ts';
export { createOAuthFetch, type OAuthFetchOptions } from './fetch.ts';
export { CREDENTIALS_ENV, FileCredentialStore, MemoryCredentialStore, defaultCredentialsPath, type FileCredentialStoreOptions } from './store.ts';
export { runDeviceFlow, type DeviceAuthorization, type DeviceFlowOptions, type DevicePoll } from './device-code.ts';
export { startCallbackServer, type CallbackServer, type CallbackServerOptions } from './callback-server.ts';
export { generatePkce, randomState, type Pkce } from './pkce.ts';
export { foldResponsesStream } from './sse.ts';
export { createCodexProvider, type CodexCredentials, type CodexLoginOptions, type CodexProviderOptions } from './providers/openai-codex.ts';
export { copilotBaseUrl, createCopilotProvider, type CopilotCredentials, type CopilotLoginOptions, type CopilotProviderOptions } from './providers/github-copilot.ts';
export { createXaiProvider, type XaiLoginOptions, type XaiProviderOptions } from './providers/xai.ts';
export { PROVIDER_IDS, getDefaultStore, getProvider, isBuiltInProviderId, setDefaultStore, type BuiltInProviderId } from './registry.ts';
export { login, logout, status, type LoginOptions, type LoginStatus } from './login.ts';
