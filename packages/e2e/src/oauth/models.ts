/** Lists the models a stored subscription login serves, through the login's own fetch. */

import { OAuthError } from './errors.ts';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, getProvider, loginHint, type ProviderId } from './providers.ts';
import { defaultCredentialStore } from './store.ts';
import type { CredentialStore, SubscriptionModel } from './types.ts';

/** The models `providerId`'s stored login serves; `NOT_LOGGED_IN` without one. */
export async function listModels(providerId: ProviderId, store: CredentialStore = defaultCredentialStore()): Promise<SubscriptionModel[]> {
  const provider = getProvider(providerId);
  if (provider.models === undefined) throw new OAuthError('MISCONFIGURED', `${provider.name} publishes no model list`);
  const fetch = createOAuthFetch(provider, { store, userAgent: USER_AGENT, loginHint: loginHint(providerId) });
  return provider.models(fetch);
}
