/**
 * Lazy loader for the optional `ai` peer dependency. Deterministic suites and custom
 * executors never load the AI SDK; everything model-backed funnels through
 * here, so the install weight is opt-in and the failure mode is one clear
 * MODEL_UNAVAILABLE instead of a module-resolution crash at startup.
 */

import { realmSlot } from '../internal/realm-slot.ts';
import { AgentError } from './error.ts';

export type AiSdk = typeof import('ai');

/**
 * The cache lives on `globalThis`, not in module state: config and test
 * modules load in an isolated tsx realm, so an executor constructed in config
 * code and the runner's own model plumbing would otherwise hold two separate
 * caches — and two separate `ai` module instances whose error classes fail
 * each other's instanceof checks. One slot, one SDK instance, every realm.
 */
const cacheSlot = realmSlot<{ loaded?: AiSdk; failure?: Error }>('e2e.ai-sdk.v1');

function cache(): { loaded?: AiSdk; failure?: Error } {
  let state = cacheSlot.get(globalThis);
  if (state === undefined) {
    state = {};
    cacheSlot.set(globalThis, state);
  }
  return state;
}

/** Loads and caches the AI SDK, or fails with MODEL_UNAVAILABLE. */
export async function loadAiSdk(): Promise<AiSdk> {
  const state = cache();
  if (state.loaded !== undefined) return state.loaded;
  if (state.failure !== undefined) throw missing(state.failure);
  try {
    state.loaded = await import('ai');
    return state.loaded;
  } catch (cause) {
    state.failure = cause instanceof Error ? cause : new Error(String(cause));
    throw missing(state.failure);
  }
}

/**
 * The already-loaded SDK, for the few synchronous seams (error-class checks)
 * that run strictly after an async caller primed the cache.
 */
export function aiSdk(): AiSdk {
  const state = cache();
  if (state.loaded === undefined) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      'the AI SDK has not been loaded; load the ai package before reading the model',
    );
  }
  return state.loaded;
}

function missing(cause: Error): AgentError {
  return new AgentError(
    'MODEL_UNAVAILABLE',
    'the "ai" package is not installed; model-backed agent calls require the optional ' +
      'peer dependency ai@^7 — install it, or configure an agent that brings ' +
      'its own model transport',
    { cause },
  );
}
