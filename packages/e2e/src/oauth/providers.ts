/** The built-in providers by id, and the login options each one takes. */

import { createCodexProvider, type CodexLoginOptions } from './providers/openai.ts';
import { createCopilotProvider, type CopilotLoginOptions } from './providers/github-copilot.ts';
import { createOpencodeConsoleProvider } from './providers/opencode-console.ts';
import { createXaiProvider } from './providers/xai.ts';
import { EnvCredentialStore, defaultCredentialStore } from './store.ts';
import type { CredentialStore, OAuthProvider } from './types.ts';

export interface LoginOptionsById {
  readonly openai: CodexLoginOptions;
  readonly 'github-copilot': CopilotLoginOptions;
  readonly 'opencode-console': Record<string, never>;
  readonly spacexai: Record<string, never>;
}

export type ProviderId = keyof LoginOptionsById;

export const PROVIDER_IDS = ['openai', 'github-copilot', 'opencode-console', 'spacexai'] as const satisfies readonly ProviderId[];

// Method shorthand is bivariant, so each specialised provider fits the base interface without a cast.
const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  openai: createCodexProvider(),
  'github-copilot': createCopilotProvider(),
  'opencode-console': createOpencodeConsoleProvider(),
  spacexai: createXaiProvider(),
};

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}

/** How a missing login is described to the user: the CLI command that fixes it, and the API key variable that does too. */
export function loginHint(id: ProviderId): string {
  const command = `run \`npx e2e login ${id}\``;
  const variable = PROVIDERS[id].apiKeyEnv;
  return variable === undefined ? command : `${command} or set ${variable}`;
}

/** The provider's API key from its `apiKeyEnv` variable, when that is set. */
export function apiKeyFor(id: ProviderId): string | undefined {
  const variable = PROVIDERS[id].apiKeyEnv;
  const apiKey = variable === undefined ? undefined : process.env[variable]?.trim();
  return apiKey === '' ? undefined : apiKey;
}

/**
 * Where `id`'s calls read their credential: the API key, when set, as a
 * login with nothing to refresh, else `store`, the default store unless
 * given. The default store is only opened without a key, so a malformed
 * `E2E_OAUTH_CREDENTIALS` does not block the key. The hint names the remedy
 * for the credential actually read.
 */
export function credentialSource(id: ProviderId, store?: CredentialStore): { readonly store: CredentialStore; readonly loginHint: string } {
  const apiKey = apiKeyFor(id);
  if (apiKey === undefined) return { store: store ?? defaultCredentialStore(), loginHint: loginHint(id) };
  return {
    store: new EnvCredentialStore(JSON.stringify({ [id]: { access: apiKey, refresh: '', expires: 0 } })),
    loginHint: `check ${PROVIDERS[id].apiKeyEnv}`,
  };
}
