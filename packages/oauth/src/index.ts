/**
 * Sign in to a personal AI subscription once, then use it as an AI SDK model.
 *
 * Model constructors live on subpaths so a config installs only the provider
 * package it uses: `@e2edev/oauth/chatgpt`, `@e2edev/oauth/copilot`,
 * `@e2edev/oauth/grok`. This entry holds the flows, the stores, and the fetch
 * for anyone wiring a provider of their own.
 */

export type { CredentialStore, FetchFunction, OAuthAuthInfo, OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProvider } from './types.ts';
export { OAuthError, type OAuthErrorCode } from './errors.ts';
export { createOAuthFetch, type OAuthFetchOptions } from './fetch.ts';
export { CREDENTIALS_ENV, EnvCredentialStore, FileCredentialStore, MemoryCredentialStore, defaultCredentialStore, defaultCredentialsPath } from './store.ts';
export { rfc8628Flow, runDeviceFlow, type DeviceAuthorization, type DeviceFlowOptions, type DevicePoll, type Rfc8628Options } from './device-code.ts';
export { requestTokens, type TokenResponse } from './token-endpoint.ts';
export { foldResponsesStream } from './sse.ts';
export { createCodexProvider, type CodexCredentials, type CodexLoginOptions, type CodexProviderOptions } from './providers/openai.ts';
export { copilotBaseUrl, createCopilotProvider, enterpriseHost, type CopilotCredentials, type CopilotLoginOptions, type CopilotProviderOptions } from './providers/github-copilot.ts';
export { createXaiProvider, type XaiProviderOptions } from './providers/xai.ts';
export { PROVIDER_IDS, getProvider, isProviderId, type LoginOptionsById, type ProviderId } from './providers.ts';
export { login, logout, type LoginInput } from './login.ts';
