/**
 * Which subscription login a model from `e2e/oauth/*` reads, kept on the
 * instance so `e2e doctor` can check that login without calling the model.
 * A registry symbol, not module state: the config may load its own copy of e2e.
 */

import { realmSlot } from '../internal/realm-slot.ts';
import type { ProviderId } from './providers.ts';

const loginSlot = realmSlot<ProviderId>('e2e.oauth.login.v1');

/** Records that `model` reads the stored login of `provider`, and returns it. */
export function withLogin<T extends object>(model: T, provider: ProviderId): T {
  loginSlot.set(model, provider);
  return model;
}

/** The provider whose stored login `model` reads, or undefined for a model no `e2e/oauth` constructor made. */
export function loginOf(model: unknown): ProviderId | undefined {
  return loginSlot.get(model);
}
