/** The built-in providers by id, and the shared defaults the model constructors use. */

import { createCodexProvider } from './providers/openai-codex.ts';
import { createCopilotProvider } from './providers/github-copilot.ts';
import { createXaiProvider } from './providers/xai.ts';
import { FileCredentialStore } from './store.ts';
import type { CredentialStore, OAuthProvider } from './types.ts';

export type BuiltInProviderId = 'openai-codex' | 'github-copilot' | 'xai';

export const PROVIDER_IDS: readonly BuiltInProviderId[] = ['openai-codex', 'github-copilot', 'xai'];

const providers: Record<BuiltInProviderId, OAuthProvider<never>> = {
  'openai-codex': createCodexProvider() as OAuthProvider<never>,
  'github-copilot': createCopilotProvider() as OAuthProvider<never>,
  xai: createXaiProvider() as OAuthProvider<never>,
};

export function getProvider(id: string): OAuthProvider<never> | undefined {
  return (providers as Record<string, OAuthProvider<never>>)[id];
}

export function isBuiltInProviderId(id: string): id is BuiltInProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

let defaultStore: CredentialStore | undefined;

/** The store the model constructors read: the credentials file unless replaced. */
export function getDefaultStore(): CredentialStore {
  defaultStore ??= new FileCredentialStore();
  return defaultStore;
}

export function setDefaultStore(store: CredentialStore | undefined): void {
  defaultStore = store;
}

export const USER_AGENT = 'e2e-oauth';

/** How a missing login is described to the user; the CLI command that fixes it. */
export function loginHint(id: string): string {
  return `run \`e2e login ${id}\` (or \`npx e2e-oauth login ${id}\`)`;
}
