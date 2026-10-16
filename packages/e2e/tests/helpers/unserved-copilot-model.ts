/**
 * A Copilot-shaped scripted model whose every call the account cannot use,
 * marked the way `copilot()` marks a `model_not_supported` answer. A config
 * file on the worker path builds it itself, so it lives beside the other
 * helpers a fixture config imports.
 */

import { APICallError } from '@ai-sdk/provider';
import { markUnservedModel } from '../../src/internal/unserved-model.ts';
import type { ModelInstance } from '../../src/types.ts';
import { createScriptedInstance } from './scripted-model.ts';

const REFUSED_MODEL_ID = 'claude-haiku-4.5';

/** The explanation `copilot()` attaches, as a run error quotes it. */
export const REFUSAL_EXPLANATION = `GitHub Copilot does not serve ${REFUSED_MODEL_ID} to this account: the plan does not include it, it is turned off in Copilot settings on GitHub, or Copilot lists no such id; npx e2e models github-copilot lists the ids, and the listing cannot see plan limits`;

/** Builds the refusing model; each call fails like Copilot's 400 and carries the mark. */
export function refusedCopilotModel(): ModelInstance {
  return createScriptedInstance('github-copilot.chat', REFUSED_MODEL_ID, async () => {
    throw markUnservedModel(
      new APICallError({
        message: 'The requested model is not supported.',
        url: 'https://api.githubcopilot.com/chat/completions',
        requestBodyValues: {},
        statusCode: 400,
        responseBody: '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}',
      }),
      REFUSAL_EXPLANATION,
    );
  });
}
