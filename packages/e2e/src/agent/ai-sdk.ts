/**
 * Lazy loader for the optional `ai` peer dependency (RFC0001: "AI SDK is a
 * peerDependency with a tested range"). Deterministic suites and custom
 * executors never load the AI SDK; everything model-backed funnels through
 * here, so the install weight is opt-in and the failure mode is one clear
 * MODEL_UNAVAILABLE instead of a module-resolution crash at startup.
 */

import { AgentError } from './error.ts';

export type AiSdk = typeof import('ai');

let loaded: AiSdk | undefined;
let failure: Error | undefined;

/** Loads and caches the AI SDK, or fails with MODEL_UNAVAILABLE. */
export async function loadAiSdk(): Promise<AiSdk> {
  if (loaded !== undefined) return loaded;
  if (failure !== undefined) throw missing(failure);
  try {
    loaded = await import('ai');
    return loaded;
  } catch (cause) {
    failure = cause instanceof Error ? cause : new Error(String(cause));
    throw missing(failure);
  }
}

/**
 * The already-loaded SDK, for the few synchronous seams (gateway model
 * construction) that run strictly after an async caller primed the cache.
 */
export function aiSdk(): AiSdk {
  if (loaded === undefined) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      'gateway model references require the AI SDK, which has not been loaded; ' +
        'supply an agent.model instance, or load the ai package before reading the model',
    );
  }
  return loaded;
}

function missing(cause: Error): AgentError {
  return new AgentError(
    'MODEL_UNAVAILABLE',
    'the "ai" package is not installed; model-backed agent calls require the optional ' +
      'peer dependency ai@^7 — install it, or configure an agent.executor that brings ' +
      'its own model transport',
    { cause },
  );
}
