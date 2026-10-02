/**
 * `orcarouterAuth('openai/gpt-5')`: OrcaRouter reached by signing in to the
 * user's own account with OAuth 2.0 + PKCE. `e2e login orcarouter-oauth` mints
 * an ordinary `sk-orca-…` key and stores it exactly where the pasted-key entry
 * keeps one, so this constructor and `orcarouter()` send identical requests.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { orcaRouterModel } from './orcarouter-model.ts';
import { AUTH_PROVIDER_ID } from './providers/orcarouter.ts';

export function orcarouterAuth(modelId: string): LanguageModelV4 {
  return orcaRouterModel(AUTH_PROVIDER_ID, modelId);
}
