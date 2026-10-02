/**
 * `orcarouter('openai/gpt-5')`: OrcaRouter reached with an API key the user
 * already holds. The key comes from `ORCAROUTER_API_KEY`, or from
 * `e2e login orcarouter`, which stores it in the credential file the other
 * logins use. The instance is `@ai-sdk/openai-compatible`'s chat model at
 * `https://api.orcarouter.ai/v1`; `e2e models orcarouter` lists the ids.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { orcaRouterModel } from './orcarouter-model.ts';
import { API_KEY_PROVIDER_ID } from './providers/orcarouter.ts';

export function orcarouter(modelId: string): LanguageModelV4 {
  return orcaRouterModel(API_KEY_PROVIDER_ID, modelId);
}
