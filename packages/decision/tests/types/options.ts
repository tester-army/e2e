import type { Experimental_EvaluationModelV4 } from '@ai-sdk/provider';
import type { E2EConfig } from 'e2e';
import { decisionExecutor } from '@e2e-dev/decision';

const model: Experimental_EvaluationModelV4 = {
  specificationVersion: 'v4',
  provider: 'test',
  modelId: 'test-1',
  supportedQuestionTypes: ['choice'],
  doEvaluate: () => Promise.resolve({ answers: {}, warnings: [] }),
};
const executor = decisionExecutor({ model });
const agents: E2EConfig['agents'] = { default: { executor } };
void agents;

// @ts-expect-error A decision executor requires an evaluation model, not a model id.
decisionExecutor({ model: 'jev-latest' });
// @ts-expect-error The text model is an instance, never an id string.
decisionExecutor({ model, textModel: 'openai/gpt-4o' });
