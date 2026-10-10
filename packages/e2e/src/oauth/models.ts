/** Lists the models a stored subscription login serves, through the login's own fetch. */

import { OAuthError } from './errors.ts';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT } from '../internal/client-identity.ts';
import { getProvider, loginHint, type ProviderId } from './providers.ts';
import { opencodeConsoleApiKeyStore, OPENCODE_API_KEY_ENV } from './providers/opencode-console.ts';
import { defaultCredentialStore } from './store.ts';
import type { CredentialStore, SubscriptionModel } from './types.ts';

/**
 * The models `providerId`'s credentials serve; `NOT_LOGGED_IN` without any.
 *
 * A stored login wins, so nothing that works today changes. With no stored
 * login, a provider that also accepts an environment credential reads the
 * model list through it: `OPENCODE_API_KEY` is the same credential
 * `opencodeConsole()` uses in place of the login, and it serves the ids the
 * model constructor runs on.
 */
export async function listModels(providerId: ProviderId, store: CredentialStore = defaultCredentialStore()): Promise<SubscriptionModel[]> {
  const provider = getProvider(providerId);
  if (provider.models === undefined) throw new OAuthError('MISCONFIGURED', `${provider.name} publishes no model list`);
  const fromEnvironment = await environmentCredential(providerId, store);
  const fetch = createOAuthFetch(provider, {
    store: fromEnvironment ?? store,
    userAgent: USER_AGENT,
    loginHint: fromEnvironment === undefined ? loginHint(providerId) : `check ${OPENCODE_API_KEY_ENV}`,
  });
  return provider.models(fetch);
}

/** The environment credential for `providerId`, when its login is not stored and the variable is set. */
async function environmentCredential(providerId: ProviderId, store: CredentialStore): Promise<CredentialStore | undefined> {
  if (providerId !== 'opencode-console' || (await store.get(providerId)) !== undefined) return undefined;
  const apiKey = process.env[OPENCODE_API_KEY_ENV]?.trim();
  return apiKey === undefined || apiKey === '' ? undefined : opencodeConsoleApiKeyStore(apiKey);
}
