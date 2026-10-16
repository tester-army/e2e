import { describe, expect, it } from 'vitest';
import { decisionExecutor } from '../src/index.ts';
import { scriptedDecision, scriptedText } from './helpers.ts';

const EXAMPLE = "pass an AI SDK decision model, e.g. decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest') })";

describe('decisionExecutor model errors', () => {
  it.each([
    ['no options', undefined, `decisionExecutor() takes an options object; ${EXAMPLE}`],
    ['no model', {}, `decisionExecutor({ model }) got undefined; ${EXAMPLE}`],
    ['a model id', { model: 'openai/gpt-5' }, `decisionExecutor({ model }) got the string "openai/gpt-5"; ${EXAMPLE}`],
    ['an uncalled provider factory', { model: (id: string) => id }, `decisionExecutor({ model }) got a function, not a model; call it with a model id, ${EXAMPLE}`],
    ['a language model', { model: scriptedText([]).model }, `decisionExecutor({ model }) got the language model scripted-text/scripted-text-1; ${EXAMPLE}`],
    ['a plain object', { model: { modelId: 'x' } }, `decisionExecutor({ model }) got an object that is not a decision model; ${EXAMPLE}`],
    [
      'a v3 model',
      { model: { specificationVersion: 'v3', provider: 'p', modelId: 'm', doDecide: () => undefined } },
      'decisionExecutor({ model }) got p/m, a v3 model; the AI SDK decides with v4 decision models',
    ],
    [
      'a decision model without choice questions',
      { model: scriptedDecision(() => ({ choice: 'done' }), { supported: ['boolean'] }).model },
      'decisionExecutor({ model }) got scripted/scripted-1, which does not answer choice questions',
    ],
  ])('refuses %s with the full message', (_name, options, message) => {
    expect(() => decisionExecutor(options as never)).toThrow(expect.objectContaining({ name: 'ConfigurationError', code: 'INVALID_CONFIG', message }));
  });
});
