/**
 * Model adapter registry (spec 05-config.md). Provider names resolve through
 * this registry; the AI Gateway adapter is the documented default and reaches
 * every gateway-supported provider, so switching provider is a config change.
 */

import type { ResolvedModel } from '../../config/agent.ts';
import { AgentError } from '../error.ts';
import type { ModelAdapter } from './adapter.ts';
import { createGatewayAdapter } from './gateway.ts';

export type ModelAdapterFactory = (
  model: ResolvedModel,
  env: NodeJS.ProcessEnv,
) => ModelAdapter;

const adapters = new Map<string, ModelAdapterFactory>();

/**
 * Registers a provider-specific adapter, replacing the gateway default for
 * that provider.
 */
export function registerModelAdapter(provider: string, factory: ModelAdapterFactory): void {
  adapters.set(provider, factory);
}

/** Resolves the adapter for one model, or fails with MODEL_UNAVAILABLE. */
export function createModelAdapter(
  model: ResolvedModel | undefined,
  env: NodeJS.ProcessEnv,
): ModelAdapter {
  if (model === undefined) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      'the agent fixture requires model configuration: set agent.model or E2E_MODEL to "provider/model-id"',
    );
  }
  const factory = adapters.get(model.provider) ?? createGatewayAdapter;
  return factory(model, env);
}
