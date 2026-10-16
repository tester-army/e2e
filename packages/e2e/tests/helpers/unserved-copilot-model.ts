/** A Copilot-shaped failure and model the account cannot use, marked as `copilot()` marks a refusal; a worker-path config file imports it. */

import { APICallError } from '@ai-sdk/provider';
import { markUnservedModel } from '../../src/internal/unserved-model.ts';
import { copilotRefusal } from '../../src/oauth/providers/github-copilot.ts';
import type { ModelInstance } from '../../src/types.ts';
import { createScriptedInstance } from './scripted-model.ts';

const REFUSED_MODEL_ID = 'claude-haiku-4.5';

/** The explanation `copilot()` attaches, as a run error quotes it. */
export const REFUSAL_EXPLANATION = copilotRefusal(REFUSED_MODEL_ID);

/** One refused call's failure as `copilot()` rethrows it: the AI SDK's error over Copilot's 400, carrying the mark. */
export function refusedCopilotFailure(): APICallError {
  return markUnservedModel(
    new APICallError({
      message: 'The requested model is not supported.',
      url: 'https://api.githubcopilot.com/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}',
    }),
    REFUSAL_EXPLANATION,
  );
}

/** Builds the refusing model; each call fails with `refusedCopilotFailure()`. */
export function refusedCopilotModel(): ModelInstance {
  return createScriptedInstance('github-copilot.chat', REFUSED_MODEL_ID, async () => {
    throw refusedCopilotFailure();
  });
}
