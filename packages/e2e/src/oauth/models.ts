/** Lists the models a subscription serves, through the credential's own fetch. */

import { OAuthError } from './errors.ts';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT } from '../internal/client-identity.ts';
import { credentialSource, getProvider, type ProviderId } from './providers.ts';
import type { CredentialStore, SubscriptionModel } from './types.ts';

/** The models `providerId`'s credential serves: its API key when set, as its model constructor reads it, else the stored login; `NOT_LOGGED_IN` without either. */
export async function listModels(providerId: ProviderId, store?: CredentialStore): Promise<SubscriptionModel[]> {
  const provider = getProvider(providerId);
  if (provider.models === undefined) throw new OAuthError('MISCONFIGURED', `${provider.name} publishes no model list`);
  const fetch = createOAuthFetch(provider, { ...credentialSource(providerId, store), userAgent: USER_AGENT });
  return provider.models(fetch);
}
