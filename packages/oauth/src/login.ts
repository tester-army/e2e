/** Runs a provider's login and keeps the result; the CLI and embedders share it. */

import { OAuthError } from './errors.ts';
import { getDefaultStore, getProvider } from './registry.ts';
import type { CredentialStore, OAuthCredentials, OAuthLoginCallbacks } from './types.ts';

export interface LoginOptions<ProviderOptions> {
  readonly store?: CredentialStore;
  readonly callbacks: OAuthLoginCallbacks;
  readonly options?: ProviderOptions;
}

export async function login<ProviderOptions = Record<string, unknown>>(
  providerId: string,
  input: LoginOptions<ProviderOptions>,
): Promise<OAuthCredentials> {
  const provider = getProvider(providerId);
  if (provider === undefined) throw new OAuthError('MISCONFIGURED', `unknown provider ${providerId}`);
  const store = input.store ?? getDefaultStore();
  const credentials = await provider.login(input.callbacks, input.options as never);
  await store.set(provider.id, credentials);
  return credentials;
}

export async function logout(providerId: string, store: CredentialStore = getDefaultStore()): Promise<boolean> {
  const had = (await store.get(providerId)) !== undefined;
  await store.remove(providerId);
  return had;
}

export interface LoginStatus {
  readonly id: string;
  readonly name: string;
  readonly loggedIn: boolean;
  /** Epoch milliseconds, `0` for a token without expiry, undefined when not logged in. */
  readonly expires?: number;
}

export async function status(store: CredentialStore = getDefaultStore()): Promise<LoginStatus[]> {
  const ids = await store.list();
  const out: LoginStatus[] = [];
  for (const id of ids) {
    const provider = getProvider(id);
    const credentials = await store.get(id);
    out.push({
      id,
      name: provider?.name ?? id,
      loggedIn: credentials !== undefined,
      ...(credentials === undefined ? {} : { expires: credentials.expires }),
    });
  }
  return out;
}
