import { ConfigurationError } from 'e2e/engine';
/** What a factory needs from its decision model, and how its errors name the fix. */
export interface ModelNeeds {
  /** The factory, as every error names it, e.g. `decisionExecutor`. */
  readonly caller: string;
  /** The question type the factory asks. */
  readonly questionType: 'choice' | 'boolean';
  /** How a valid model reads, ending the errors about a value that is no decision model. */
  readonly example: string;
}
/**
 * Rejects anything the AI SDK cannot decide with, at config load: a model id
 * string, a language model, or a decision model that cannot answer the
 * caller's question type.
 */
export function checkModel(model: unknown, { caller, questionType, example }: ModelNeeds): void {
  if (typeof model === 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `${caller}({ model }) got a function, not a model; call it with a model id, ${example}`);
  }
  if (typeof model !== 'object' || model === null) {
    const got = typeof model === 'string' ? `the string ${JSON.stringify(model)}` : String(model);
    throw new ConfigurationError('INVALID_CONFIG', `${caller}({ model }) got ${got}; ${example}`);
  }
  const fields = model as Record<string, unknown>;
  const name = `${String(fields['provider'])}/${String(fields['modelId'])}`;
  if (typeof fields['doDecide'] !== 'function' && typeof fields['doEvaluate'] !== 'function') {
    const kind = typeof fields['doGenerate'] === 'function' ? `the language model ${name}` : 'an object that is not a decision model';
    throw new ConfigurationError('INVALID_CONFIG', `${caller}({ model }) got ${kind}; ${example}`);
  }
  if (fields['specificationVersion'] !== 'v4') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${caller}({ model }) got ${name}, a ${String(fields['specificationVersion'])} model; the AI SDK decides with v4 decision models`,
    );
  }
  const supported = fields['supportedQuestionTypes'];
  if (!Array.isArray(supported) || !supported.includes(questionType)) {
    throw new ConfigurationError('INVALID_CONFIG', `${caller}({ model }) got ${name}, which does not answer ${questionType} questions`);
  }
}
