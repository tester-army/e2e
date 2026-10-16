/** Runs a provider's login and keeps the result; the CLI and embedders share it. */

import { getProvider, type LoginOptionsById, type ProviderId } from './providers.ts';
import { defaultCredentialStore, EnvCredentialStore } from './store.ts';
import type { CredentialStore, OAuthCredentials, OAuthLoginCallbacks } from './types.ts';

export interface LoginInput<Id extends ProviderId> {
  readonly callbacks: OAuthLoginCallbacks;
  readonly options?: LoginOptionsById[Id];
  readonly store?: CredentialStore;
}

export async function login<Id extends ProviderId>(providerId: Id, input: LoginInput<Id>): Promise<OAuthCredentials> {
  const store = input.store ?? defaultCredentialStore();
  if (store instanceof EnvCredentialStore) store.assertWritable();
  const credentials = await getProvider(providerId).login(input.callbacks, input.options);
  await store.set(providerId, credentials);
  return credentials;
}

/** Forgets a stored login; true when there was one. */
export async function logout(providerId: ProviderId, store: CredentialStore = defaultCredentialStore()): Promise<boolean> {
  if ((await store.get(providerId)) === undefined) return false;
  await store.remove(providerId);
  return true;
}
