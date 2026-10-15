import { typeSafeAi } from '@ai-sdk/typesafe-ai';
import type { E2EConfig } from 'e2e';
import { decisionExecutor } from '@e2e-dev/decision';

const executor = decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest') });
const agents: E2EConfig['agents'] = { default: { executor } };
void agents;

// The deprecated evaluation model shape stays accepted.
decisionExecutor({ model: typeSafeAi.evaluationModel('jev-latest') });
decisionExecutor({
  model: {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-1',
    supportedQuestionTypes: ['choice'],
    doEvaluate: () => Promise.resolve({ answers: {}, warnings: [] }),
  },
});
decisionExecutor({
  model: {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-1',
    supportedQuestionTypes: ['choice'],
    doDecide: () => Promise.resolve({ answers: {}, warnings: [] }),
  },
});

decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest'), providerOptions: { gateway: { zeroDataRetention: true } } });

// @ts-expect-error A decision executor requires a decision model, not a model id.
decisionExecutor({ model: 'jev-latest' });
// @ts-expect-error The text model is an instance, never an id string.
decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest'), textModel: 'openai/gpt-4o' });
// @ts-expect-error A model with neither doDecide nor doEvaluate is not a decision model.
decisionExecutor({ model: { specificationVersion: 'v4', provider: 'test', modelId: 'test-1', supportedQuestionTypes: ['choice'] } });
