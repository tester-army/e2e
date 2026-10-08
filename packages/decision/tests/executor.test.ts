import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, InvalidResponseDataError, LoadAPIKeyError } from 'ai';
import { AgentError } from 'e2e/agent';
import type { ExecutorNode } from 'e2e';
import { decisionExecutor } from '../src/index.ts';
import { PNG } from 'pngjs';
import { context, scriptedDecision, scriptedOutputs, scriptedText } from './helpers.ts';

/** Matches the ConfigurationError a factory throws at config load. */
function invalidConfig(message: string): object {
  return expect.objectContaining({ name: 'ConfigurationError', code: 'INVALID_CONFIG', message: expect.stringContaining(message) });
}
const BUTTONS: ExecutorNode = { id: 'root', children: [
  { id: 'save', role: 'button', name: 'Save' },
  { id: 'cancel', role: 'button', name: 'Cancel' },
]};
const FIELD: ExecutorNode = { id: 'root', children: [
  { id: 'name', role: 'textbox', name: 'Name', value: '' },
  { id: 'save', role: 'button', name: 'Save' },
]};

/** Construction-time validation: gates and model support. */
describe('construction', () => {
  it('rejects gates outside [0, 1]', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    for (const bad of [-1, 2, NaN]) {
      expect(() => decisionExecutor({ model, minProbability: bad })).toThrow(invalidConfig('between 0 and 1'));
      expect(() => decisionExecutor({ model, minConfidence: bad })).toThrow(invalidConfig('between 0 and 1'));
    }
  });
  it('rejects a model without choice support', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }), { supported: [] });
    expect(() => decisionExecutor({ model })).toThrow(invalidConfig('got scripted/scripted-1, which does not answer choice questions'));
  });
  it.each([
    ['no options', undefined, 'decisionExecutor() takes an options object'],
    ['no model', {}, 'decisionExecutor({ model }) got undefined;'],
    ['a model id', { model: 'openai/gpt-5' }, 'decisionExecutor({ model }) got the string "openai/gpt-5";'],
    ['an uncalled provider factory', { model: (id: string) => id }, 'decisionExecutor({ model }) got a function, not a model; call it'],
    ['a language model', { model: scriptedText([]).model }, 'got the language model scripted-text/scripted-text-1;'],
    ['a plain object', { model: { modelId: 'x' } }, 'got an object that is not a decision model;'],
    ['a v3 model', { model: { specificationVersion: 'v3', provider: 'p', modelId: 'm', doDecide: () => undefined } }, 'got p/m, a v3 model'],
  ])('rejects %s as INVALID_CONFIG naming the fix', (_name, options, message) => {
    expect(() => decisionExecutor(options as never)).toThrow(invalidConfig(message));
  });
  it('accepts a decision model and a deprecated evaluation model', () => {
    for (const legacy of [undefined, true] as const) {
      const { model } = scriptedDecision(() => ({ choice: 'done' }), legacy === undefined ? {} : { legacy });
      expect(decisionExecutor({ model }).name).toBe('decision');
    }
  });
  it.each([
    ['an array', []],
    ['a string', 'gateway'],
    ['a provider mapped to a non-object', { gateway: true }],
    ['a class instance', new Date()],
    ['a provider mapped to a class instance', { gateway: new Date() }],
  ])('rejects providerOptions that are %s', (_name, providerOptions) => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    expect(() => decisionExecutor({ model, providerOptions: providerOptions as never })).toThrow(invalidConfig('maps provider names to option objects'));
  });
  it('exposes the text model and replays cache', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    const text = scriptedText([]);
    const executor = decisionExecutor({ model, textModel: text.model });
    expect(executor.cache).toBe('inherit');
    expect(executor.model).toBe(text.model);
    expect(executor.name).toBe('decision');
  });
});


describe('act loop', () => {
  it('taps a button and passes on a held completion check', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap' : 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(['operation']);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(['target']);
    expect(Object.keys(requests[1]?.questions['target']?.criteria as object)).toEqual(['1', '2', 'none']);
    expect(requests[1]?.questions['target']?.instructions).toContain('The next operation is "tap"');
    expect(fixture.usage).toHaveLength(4);
    expect(fixture.usage[0]).toMatchObject({ provider: 'scripted', modelId: 'scripted-1' });
    expect(fixture.turns.length).toBeGreaterThan(0);
    expect(fixture.transcripts).toHaveLength(1);
  });
  it('sends providerOptions with every decide call, and none when unset', async () => {
    const script = (id: string, keys: string[], call: number) =>
      id === 'operation' ? { choice: call === 0 ? 'tap' : 'done' } : id === 'verdict' ? { choice: 'holds' } : { choice: keys[0] ?? '' };
    const providerOptions = { gateway: { zeroDataRetention: true } };
    const withOptions = scriptedDecision(script);
    const fixture = context({ tree: BUTTONS });
    expect(await decisionExecutor({ model: withOptions.model, providerOptions }).runStep(fixture.ctx)).toMatchObject({ status: 'passed' });
    expect(withOptions.requests).toHaveLength(4);
    for (const request of withOptions.requests) expect(request.providerOptions).toEqual(providerOptions);
    const without = scriptedDecision(script);
    expect(await decisionExecutor({ model: without.model }).runStep(context({ tree: BUTTONS }).ctx)).toMatchObject({ status: 'passed' });
    // The SDK sends an empty object when the caller passes none.
    for (const request of without.requests) expect(request.providerOptions ?? {}).toEqual({});
  });
  it('runs a deprecated evaluation model through the same loop', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap' : 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      return { choice: keys[0] ?? '' };
    }, { legacy: true });
    const fixture = context({ tree: BUTTONS });
    expect(await decisionExecutor({ model }).runStep(fixture.ctx)).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
  });
  it('dispatches a lone target with no target question', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: { id: 'root', children: [{ id: 'only', role: 'button', name: 'Only' }] } });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(['operation']);
  });
  it('stops on blocked without acting', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(fixture.actions.tap).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});

describe('secrets', () => {
  const LOGIN: ExecutorNode = { id: 'root', children: [{ id: 'pw', role: 'textbox', name: 'Password', inputPurpose: 'password' }] };
  it('asks the secret question only with two or more secrets', async () => {
    const scripted = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'typeSecret' : 'done' };
      if (id === 'secret') return { choice: 'password' };
      if (id === 'verdict') return { choice: 'holds' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree: LOGIN, secrets: [{ name: 'password', purpose: 'password' }, { name: 'token', purpose: 'generic-secret' }] });
    const verdict = await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(scripted.requests.some((request) => 'secret' in request.questions)).toBe(true);
    expect(fixture.actions.typeSecret).toHaveBeenCalledTimes(1);
    expect(fixture.actions.typeSecret).toHaveBeenCalledWith({ id: 'pw' }, 'password');
  });
  it('fills a lone secret with no secret question', async () => {
    const scripted = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'typeSecret' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: LOGIN });
    await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(scripted.requests.every((request) => !('secret' in request.questions))).toBe(true);
    expect(fixture.actions.typeSecret).toHaveBeenCalledTimes(1);
  });
});

describe('field text', () => {
  it('types the text-model value into the chosen field', async () => {
    const scripted = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'type' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const text = scriptedText(['Buy milk']);
    const fixture = context({ tree: FIELD, model: text.model });
    const verdict = await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.type).toHaveBeenCalledTimes(1);
    expect(fixture.actions.type).toHaveBeenCalledWith({ id: 'name' }, 'Buy milk');
    expect(text.prompts).toHaveLength(1);
    expect(fixture.turns[0]?.calls?.[0]).toContain('Buy milk');
  });
  it('keeps secret values out of the text prompt', async () => {
    const scripted = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'type' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const text = scriptedText(['irrelevant']);
    const fixture = context({
      tree: FIELD,
      model: text.model,
      params: { nickname: 'Ada', password: { kind: 'secret', name: 'admin.password', purpose: 'password' } },
    });
    await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(JSON.stringify(text.prompts)).toContain('Ada');
    expect(JSON.stringify(text.prompts)).not.toContain('admin.password');
  });
  it('continues with history when the goal supplies no value', async () => {
    const scripted = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'type' : call === 1 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const text = scriptedText([null]);
    const fixture = context({ tree: FIELD, model: text.model });
    const verdict = await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.type).not.toHaveBeenCalled();
    expect(fixture.actions.tap).toHaveBeenCalledTimes(1);
  });
  it('never offers type without a text model', async () => {
    const seen: string[][] = [];
    const scripted = scriptedDecision((id, keys, call) => {
      seen.push([id, ...keys]);
      return { choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? '') };
    });
    const fixture = context({ tree: FIELD });
    await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(JSON.stringify(seen)).not.toContain('"type"');
  });
  it('counts the text call toward the model-call budget', async () => {
    const scripted = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'type' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const text = scriptedText(['Buy milk']);
    const fixture = context({ tree: FIELD, model: text.model, maxModelCalls: 1 });
    const verdict = await decisionExecutor({ model: scripted.model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(text.prompts).toHaveLength(0);
    expect(fixture.usage).toHaveLength(1);
  });
});

describe('terminal checks', () => {
  it('passes done on holds', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'done' : 'blocked') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(requests).toHaveLength(2);
  });
  it('fails failed on fails with ACTION_FAILED', async () => {
    const { model } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'failed' : 'blocked') : id === 'verdict' ? 'fails' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'failed', errorCode: 'ACTION_FAILED' });
  });
  it('continues after one rejected claim with history', async () => {
    const { model } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'done' : call <= 2 ? 'tap' : 'done' };
      if (id === 'verdict') return { choice: call <= 1 ? 'fails' : 'holds' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(1);
  });
  it('ends the step on the second rejected claim, decided by the check', async () => {
    const cases = [
      { claim: 'done', check: 'fails', expected: { status: 'failed', errorCode: 'ACTION_FAILED' } },
      { claim: 'done', check: 'inconclusive', expected: { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' } },
      { claim: 'failed', check: 'holds', expected: { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' } },
      { claim: 'failed', check: 'inconclusive', expected: { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' } },
    ] as const;
    for (const { claim, check, expected } of cases) {
      const { model, requests } = scriptedDecision((id, keys) => ({
        choice: id === 'operation' ? claim : id === 'verdict' ? check : (keys[0] ?? ''),
      }));
      const fixture = context({ tree: BUTTONS });
      const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
      expect(verdict).toMatchObject(expected);
      expect(requests.filter((request) => 'verdict' in request.questions)).toHaveLength(2);
    }
  });
  it('counts a completion check under the gate as a rejection', async () => {
    const { model } = scriptedDecision((id, keys) => {
      if (id === 'operation') return { choice: 'done' };
      if (id === 'verdict') return { choice: 'holds', probabilities: { holds: 0.4, fails: 0.3, inconclusive: 0.3 }, confidence: 0.95 };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minProbability: 0.9 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
  });
  it('sends action descriptions but no model output to the check', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const check = requests.find((request) => 'verdict' in request.questions);
    expect(JSON.stringify(check?.state)).toContain('tap');
    expect(JSON.stringify(check?.state)).not.toContain('recentActions');
  });
  it('retries the claim when the check screen is incomplete', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'done' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    const good = { revision: '1', text: '#save button', truncated: false, viewport: { width: 800, height: 600 }, tree: BUTTONS };
    fixture.observe
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce({ ...good, treeUnavailable: true })
      .mockResolvedValue(good);
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    // No verdict request goes out for the incomplete screen: the claim is
    // retried on the next loop instead of passing or failing the step.
    expect(requests.filter((request) => 'verdict' in request.questions)).toHaveLength(1);
  });
  it('names select options in the target criteria', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'size', role: 'combobox', name: 'Size', children: [
        { id: 's', role: 'option', name: 'Small' },
        { id: 'l', role: 'option', name: 'Large' },
      ] },
      { id: 'save', role: 'button', name: 'Save' },
    ] };
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'select' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const criteria = requests[1]?.questions['target']?.criteria as Record<string, unknown>;
    expect(Object.values(criteria).slice(0, 2)).toEqual(['option "Small"', 'option "Large"']);
    expect(Object.keys(criteria)).toEqual(['1:0', '1:1', 'none']);
  });
});

describe('guard rails', () => {
  it('blocks three actions with no page change', async () => {
    const { model } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'tap' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(3);
  });
  it('counts a scroll that brings other nodes into view as progress', async () => {
    const { model } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call < 4 ? 'scroll_down' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    let capture = 0;
    fixture.observe.mockImplementation(async () => {
      const offset = Math.min(capture, 4) * 200;
      capture += 1;
      const tree: ExecutorNode = { id: 'root', children: Array.from({ length: 10 }, (_, index) => ({
        id: `r${index}`, role: 'button', name: `Row ${index}`,
        rect: { x: 0, y: index * 200 + 50 - offset, width: 100, height: 100 },
      })) };
      return { revision: String(capture), text: '#r0 button', truncated: false, viewport: { width: 800, height: 600 }, tree };
    });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.scroll).toHaveBeenCalledTimes(4);
  });
  it('blocks three scrolls that move nothing, as at the bottom of the page', async () => {
    const { model } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'scroll_down' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'last', role: 'button', name: 'Back to top', rect: { x: 0, y: 400, width: 100, height: 40 } },
    ] };
    const fixture = context({ tree });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', summary: 'Three actions in a row changed nothing on screen.' });
    expect(fixture.actions.scroll).toHaveBeenCalledTimes(3);
  });
  it('never trips the guard when pages keep changing', async () => {
    const { model } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call < 4 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    let n = 0;
    const first: ExecutorNode = { id: 'root', children: [{ id: 'a', role: 'button', name: 'Page A' }] };
    const second: ExecutorNode = { id: 'root', children: [{ id: 'a', role: 'button', name: 'Page B' }] };
    fixture.observe.mockImplementation(async () => {
      n += 1;
      const tree = n % 2 === 0 ? first : second;
      return { revision: String(n), text: '#a button', truncated: false, viewport: { width: 800, height: 600 }, tree };
    });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap.mock.calls.length).toBeGreaterThan(3);
  });
  it('sends failing actions back as history and rethrows hard stops', async () => {
    const { model } = scriptedDecision((id, keys, call) => ({
      // Calls alternate operation and target: two taps take four calls before done.
      choice: id === 'operation' ? (call < 4 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    fixture.actions.tap.mockRejectedValueOnce(new AgentError('POLICY_DENIED', 'denied'));
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(2);
  });
  it('rethrows STEP_TIMEOUT and CANCELLED', async () => {
    for (const code of ['STEP_TIMEOUT', 'CANCELLED'] as const) {
      const { model } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'tap' : (keys[0] ?? '') }));
      const fixture = context({ tree: BUTTONS });
      fixture.actions.tap.mockRejectedValueOnce(new AgentError(code, 'stop'));
      await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code });
    }
  });
  it('never makes the call that would exceed the budget', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'tap' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, maxModelCalls: 1 });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(requests).toHaveLength(1);
    expect(fixture.usage).toHaveLength(1);
  });
  it('records failed calls too', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: new Error('boom') });
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(fixture.usage).toHaveLength(1);
  });
});

describe('gates', () => {
  const spread = (keys: string[], choice: string, mass: number): Record<string, number> => {
    const rest = (1 - mass) / Math.max(1, keys.length - 1);
    return Object.fromEntries(keys.map((key) => [key, key === choice ? mass : rest]));
  };
  it('stays off by default', async () => {
    const { model } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return call === 0 ? { choice: 'tap', probabilities: spread(keys, 'tap', 0.2), confidence: 0.9 } : { choice: 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
  });
  it('blocks a low-probability operation under a gate', async () => {
    const { model } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'tap' : (keys[0] ?? ''),
      ...(id === 'operation' ? { probabilities: spread(keys, 'tap', 0.2), confidence: 0.9 } : {}),
    }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minProbability: 0.9 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(fixture.actions.tap).not.toHaveBeenCalled();
  });
  it('blocks a low-probability target under a gate', async () => {
    const { model } = scriptedDecision((id, keys) => {
      if (id === 'operation') return { choice: 'tap' };
      return { choice: keys[0] ?? '', probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])), confidence: 0.9 };
    });
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minProbability: 0.9 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(fixture.actions.tap).not.toHaveBeenCalled();
  });
});

describe('assert', () => {
  it('passes holds, fails fails, and calls the rest inconclusive', async () => {
    for (const [answer, status, code] of [['holds', 'passed', undefined], ['fails', 'failed', 'ASSERTION_FAILED'], ['inconclusive', 'failed', 'ASSERTION_INCONCLUSIVE']] as const) {
      const { model, requests } = scriptedDecision(() => ({ choice: answer }));
      const fixture = context({ kind: 'assert', tree: BUTTONS });
      const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
      expect(verdict.status).toBe(status);
      if (code !== undefined) expect(verdict).toMatchObject({ errorCode: code });
      expect(Object.keys(requests[0]?.questions ?? {})).toEqual(['verdict']);
    }
  });
  it('treats a gated-out verdict as inconclusive', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'holds', probabilities: { holds: 0.4, fails: 0.3, inconclusive: 0.3 }, confidence: 0.9 }));
    const fixture = context({ kind: 'assert', tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minProbability: 0.5 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'failed', errorCode: 'ASSERTION_INCONCLUSIVE' });
  });
});

describe('model failures', () => {
  it('fails without a choice distribution', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'tap', bare: true }));
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
  it('fails a probability outside [0, 1]', async () => {
    const { model } = scriptedDecision((id, keys) => {
      if (id !== 'operation') return { choice: keys[0] ?? '' };
      return { choice: 'tap', probabilities: Object.fromEntries(keys.map((key) => [key, key === 'tap' ? 1.5 : key === 'done' ? -0.5 : 0])) };
    });
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
  it('names a refusal the SDK rejects as a wrong-type answer', async () => {
    const rejected = new InvalidResponseDataError({ data: { operation: { type: 'refusal' } }, message: 'Question "operation" returned an answer with the wrong type.' });
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: rejected });
    await expect(decisionExecutor({ model }).runStep(context({ tree: BUTTONS }).ctx)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', message: 'The decision model refused to answer "operation".',
    });
  });
  it('maps provider failures without provider text', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: new Error('upstream detail') });
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.not.toMatchObject({ message: expect.stringContaining('upstream') });
  });
  it('names the API key variable the provider reads', async () => {
    const missing = new LoadAPIKeyError({ message: "TypeSafe AI API key is missing. Pass it using the 'apiKey' parameter or the TYPESAFE_AI_API_KEY environment variable." });
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: missing });
    await expect(decisionExecutor({ model }).runStep(context({ tree: BUTTONS }).ctx)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE', message: 'Set TYPESAFE_AI_API_KEY to the decision model API key.',
    });
    const { model: unnamed } = scriptedDecision(() => ({ choice: 'tap' }), { throws: new LoadAPIKeyError({ message: 'no key' }) });
    await expect(decisionExecutor({ model: unnamed }).runStep(context({ tree: BUTTONS }).ctx)).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE', message: 'Set the decision model API key.',
    });
  });
  it('rethrows InvalidArgumentError as our own bug', async () => {
    const failure = new InvalidArgumentError({ parameter: 'questions', value: 1, message: 'bad' });
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: failure });
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toBe(failure);
  });
  it('honors abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const { model } = scriptedDecision(() => ({ choice: 'tap' }));
    const fixture = context({ tree: BUTTONS, signal: controller.signal });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toThrow();
  });
});

describe('observations', () => {
  it('acts on a truncated observation', async () => {
    const { model } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS, observation: { truncated: true } });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
  });
  it('blocks act and judges inconclusive without a tree', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'holds' }));
    const act = context({ tree: BUTTONS, observation: { treeUnavailable: true } });
    expect(await decisionExecutor({ model }).runStep(act.ctx)).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    const assert = context({ kind: 'assert', tree: BUTTONS, observation: { treeUnavailable: true } });
    expect(await decisionExecutor({ model }).runStep(assert.ctx)).toMatchObject({ status: 'failed', errorCode: 'ASSERTION_INCONCLUSIVE' });
  });
  it('judges a truncated assertion on what is there', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'holds' }));
    const fixture = context({ kind: 'assert', tree: BUTTONS, observation: { truncated: true } });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
  });
});

describe('context', () => {
  it('sends the ledger and non-secret params, never secret handles', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({
      tree: BUTTONS,
      ledger: 'previous step done',
      params: {
        city: 'Lisbon',
        password: { kind: 'secret', name: 'admin.password', purpose: 'password' },
        nested: { theme: 'dark', token: { kind: 'secret', name: 'nested.token', purpose: 'token' } },
      },
    });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const state = requests[0]?.state as Record<string, unknown>;
    expect(state).toMatchObject({ previousSteps: 'previous step done', params: { city: 'Lisbon', nested: { theme: 'dark' } } });
    expect(JSON.stringify(state)).not.toContain('admin.password');
    expect(JSON.stringify(state)).not.toContain('nested.token');
  });
  it('seeds history from a replayed prefix and flags the uncertain action', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({
      tree: BUTTONS,
      replayedPrefix: {
        replayedActions: ['tap button Save'],
        totalActions: 2,
        stopReason: 'action-uncertain',
        uncertainAction: 'type Name',
      },
    });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const state = requests[0]?.state as Record<string, unknown[]> | undefined;
    const history = state?.recentActions as Record<string, unknown>[] | undefined;
    if (history === undefined) throw new Error('expected recent actions in the first request');
    expect(history[0]).toMatchObject({ action: 'tap button Save', replayed: true });
    expect(history[1]).toMatchObject({ action: 'type Name', uncertain: true });
  });
  it('keeps secret handles out of replayed summaries', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'done' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({
      tree: BUTTONS,
      replayedPrefix: {
        replayedActions: [
          'tap button "password"',
          'fill secret "password" into textbox "Password"',
          'fill secret "a.very.long.secret.handle.name.cut.at.40…" into textbox "Token"',
        ],
        totalActions: 4,
        stopReason: 'action-uncertain',
        uncertainAction: 'tap button "Sign in"',
      },
    });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const expected = [
      'tap button "password"',
      'fill secret <secret> into textbox "Password"',
      'fill secret <secret> into textbox "Token"',
    ];
    const decision = requests[0]?.state as { recentActions: { action: string }[] };
    expect(decision.recentActions.slice(0, 3).map((entry) => entry.action)).toEqual(expected);
    const check = requests[1]?.state as { actions: string[] };
    expect(check.actions.slice(0, 3)).toEqual(expected);
    expect(JSON.stringify(requests.map((request) => request.state))).not.toContain('secret \\"password\\"');
  });
  it('sends only the last 10 actions', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call < 12 ? 'tap' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree: BUTTONS });
    let capture = 0;
    fixture.observe.mockImplementation(async () => {
      capture += 1;
      const tree: ExecutorNode = { id: 'root', children: [{ id: 'a', role: 'button', name: `Page ${capture}` }] };
      return { revision: String(capture), text: '#a button', truncated: false, viewport: { width: 800, height: 600 }, tree };
    });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const state = requests[12]?.state as { recentActions?: unknown[] } | undefined;
    expect(fixture.actions.tap).toHaveBeenCalledTimes(12);
    const actions = (state?.recentActions as { action: string }[] | undefined)?.map((entry) => entry.action);
    expect(actions).toEqual(Array.from({ length: 10 }, (_, index) => `tap Page ${index + 3} [a]`));
  });
  it('gives the completion check the inputs, typed values, and actions, never claims or secrets', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'type' : 'done' };
      if (id === 'verdict') return { choice: call === 2 ? 'inconclusive' : 'holds' };
      return { choice: keys[0] ?? '' };
    });
    const text = scriptedText(['Ada']);
    const fixture = context({
      tree: FIELD,
      model: text.model,
      params: { nickname: 'Ada', password: { kind: 'secret', name: 'admin.password', purpose: 'password' } },
    });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    const checks = requests.filter((request) => 'verdict' in request.questions);
    expect(checks).toHaveLength(2);
    expect(checks[1]?.state).toMatchObject({
      params: { nickname: 'Ada' },
      actions: ['type into Name [name] = "Ada"'],
    });
    expect(JSON.stringify(checks[1]?.state)).not.toContain('admin.password');
  });
  it('shows a named status\'s text to the completion check', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'greeting', role: 'status', name: 'Greeting', text: 'Welcome back, admin!' },
      { id: 'out', role: 'button', name: 'Sign out' },
    ] };
    const { model, requests } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'done' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const fixture = context({ tree });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const check = requests.find((request) => 'verdict' in request.questions);
    const state = check?.state as { page: { text: string } } | undefined;
    expect(state?.page.text).toContain('Greeting text="Welcome back, admin!"');
  });
  it('shows filled fields to the completion check even when the step cannot type', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'name', role: 'textbox', name: 'Name', value: 'Ada' },
      { id: 'save', role: 'button', name: 'Save' },
    ] };
    const { model, requests } = scriptedDecision((id, keys) => ({
      choice: id === 'operation' ? 'done' : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    // No text model and no press verb: in the act loop the field offers no operation.
    const fixture = context({ tree, verbs: ['tap', 'type'] });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    const decision = requests[0]?.state as { elements: { label: string }[] };
    expect(decision.elements.map((element) => element.label)).toEqual(['Save']);
    const check = requests[1]?.state as { elements: { label: string; value?: string }[] };
    expect(check.elements).toContainEqual(expect.objectContaining({ label: 'Name', value: 'Ada' }));
  });
  it('shows checked state in check target criteria', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'milk', role: 'checkbox', name: 'Buy milk', states: { checked: true } },
      { id: 'dog', role: 'checkbox', name: 'Walk the dog', states: { checked: false } },
    ] };
    const { model, requests } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call === 0 ? 'check' : 'done') : id === 'verdict' ? 'holds' : (keys[1] ?? ''),
    }));
    const fixture = context({ tree });
    await decisionExecutor({ model }).runStep(fixture.ctx);
    const criteria = requests[1]?.questions['target']?.criteria as Record<string, unknown>;
    expect(Object.values(criteria).slice(0, 2)).toEqual(['[1] checkbox "Buy milk" checked', '[2] checkbox "Walk the dog" unchecked']);
    expect(fixture.actions.check).toHaveBeenCalledWith({ id: 'dog' }, true);
  });
  it('rejects an undeclared secret name', async () => {
    const login: ExecutorNode = { id: 'root', children: [{ id: 'pw', role: 'textbox', name: 'Password', inputPurpose: 'password' }] };
    const { model } = scriptedDecision((id, keys) => {
      if (id === 'operation') return { choice: 'typeSecret' };
      if (id === 'secret') return { choice: 'intruder' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({
      tree: login,
      secrets: [{ name: 'password', purpose: 'password' }, { name: 'token', purpose: 'generic-secret' }],
    });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
});

describe('new operations', () => {
  const PIXELS = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 };
  it('blocks when the model answers none for the chosen operation', async () => {
    const { model } = scriptedDecision((id) => ({ choice: id === 'operation' ? 'tap' : 'none' }));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: expect.stringContaining('chose tap but no target') });
    expect(fixture.actions.tap).not.toHaveBeenCalled();
  });
  it('drags the chosen source onto the chosen destination', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'list', role: 'list', name: 'Todo column', children: [{ id: 'card', role: 'listitem', name: 'Design review' }] },
      { id: 'done', role: 'region', name: 'Done column' },
    ] };
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'drag' : 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      if (id === 'target') return { choice: '2' };
      if (id === 'destination') return { choice: '3' };
      return { choice: keys[0] ?? '' };
    });
    const fixture = context({ tree });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.drag).toHaveBeenCalledWith({ id: 'card' }, { id: 'done' });
    expect(Object.keys(requests[1]?.questions['destination']?.criteria as object)).toEqual(['1', '2', '3', 'none']);
    expect(fixture.turns[0]?.calls[0]).toBe('drag [2] listitem "Design review" = "onto Done column"');
  });
  it('blocks a drag whose destination is none', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'card', role: 'listitem', name: 'Design review' },
      { id: 'done', role: 'region', name: 'Done column' },
    ] };
    const { model } = scriptedDecision((id) => ({ choice: id === 'operation' ? 'drag' : id === 'destination' ? 'none' : '1' }));
    const fixture = context({ tree });
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', summary: expect.stringContaining('no destination') });
    expect(fixture.actions.drag).not.toHaveBeenCalled();
  });
  it('uploads the paths the text model names, and skips an empty list', async () => {
    const tree: ExecutorNode = { id: 'root', children: [{ id: 'f', role: 'button', name: 'Attachments', attributes: { type: 'file' } }] };
    const { model } = scriptedDecision((id, keys, call) => ({
      choice: id === 'operation' ? (call < 2 ? 'upload' : 'done') : id === 'verdict' ? 'holds' : (keys[0] ?? ''),
    }));
    const text = scriptedOutputs([{ paths: [] }, { paths: ['fixtures/a.txt', 'fixtures/b.txt'] }]);
    const fixture = context({ tree, model: text.model, params: { files: ['fixtures/a.txt', 'fixtures/b.txt'] } });
    const verdict = await decisionExecutor({ model, textModel: text.model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.upload).toHaveBeenCalledTimes(1);
    expect(fixture.actions.upload).toHaveBeenCalledWith({ id: 'f' }, ['fixtures/a.txt', 'fixtures/b.txt']);
    expect(fixture.actions.tap).not.toHaveBeenCalled();
    expect(fixture.transcripts[0]).toContain('no files for this input');
  });
  it('never offers upload without a text model', async () => {
    const tree: ExecutorNode = { id: 'root', children: [{ id: 'f', role: 'button', name: 'Attachments', attributes: { type: 'file' } }] };
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    await decisionExecutor({ model }).runStep(context({ tree }).ctx);
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('upload');
  });
  it('runs hover, right-click, double-tap, long-press, and scroll-to through the grammar', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'b', role: 'button', name: 'Hold me', rect: { x: 0, y: 0, width: 50, height: 20 } },
      { id: 'p', role: 'paragraph', name: 'Footnote', rect: { x: 0, y: 5000, width: 50, height: 20 } },
    ] };
    const operations = ['hover', 'secondary_tap', 'double_tap', 'long_press', 'scroll_to'];
    const { model } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: operations[call] ?? 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      return { choice: id === 'target' ? '2' : '1' };
    });
    const fixture = context({ tree });
    // Every action changes nothing on this scripted screen; the stall guard must not fire before the fifth.
    let revision = 0;
    fixture.observe.mockImplementation(async () => ({ revision: String(revision += 1), text: 'x', truncated: false, viewport: { width: 800, height: 600 }, tree: { ...tree, children: [...(tree.children ?? []), { id: `t${revision}`, text: `tick ${revision}` }] } }));
    const verdict = await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.hover).toHaveBeenCalledWith({ id: 'b' });
    expect(fixture.actions.secondaryTap).toHaveBeenCalledWith({ id: 'b' });
    expect(fixture.actions.doubleTap).toHaveBeenCalledWith({ id: 'b' });
    expect(fixture.actions.longPress).toHaveBeenCalledWith({ id: 'b' });
    expect(fixture.actions.scrollTo).toHaveBeenCalledWith({ id: 'p' });
  });
  it('with vision, asks for pixels, sends the screenshot, and taps the point two score questions locate', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      if (id === 'x') return { choice: '2', score: 2.5 };
      if (id === 'y') return { choice: '3', score: 3 };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    const executor = decisionExecutor({ model, vision: true });
    expect(executor.vision).toBe(true);
    const verdict = await executor.runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: true });
    // (2.5 + 0.5) * 80 wide cells, (3 + 0.5) * 75 tall cells.
    expect(fixture.actions.tapAt).toHaveBeenCalledWith({ x: 240, y: 263 });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).toContain('tap_at');
    expect(Object.keys(requests[0]?.questions ?? {})).not.toContain('tap_at_target');
    // The operation question reads the tree alone; the point looks get the pixels.
    expect(requests[0]?.providerOptions ?? {}).not.toHaveProperty('decision');
    expect(requests[1]?.questions['x']).toMatchObject({ type: 'score' });
    const rows = requests[1]?.questions['y']?.criteria as unknown[] | undefined;
    expect(rows?.length).toBe(8);
    const options = requests[1]?.providerOptions as { decision: { screenshot: { mediaType: string; data: string } } };
    expect(options.decision.screenshot.mediaType).toBe('image/png');
    // Undecodable pixels go through untouched, as base64.
    expect(options.decision.screenshot.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(fixture.transcripts[0]).toContain('"screenshot":"800x600"');
    expect(fixture.turns[0]?.calls[0]).toBe('tap at (240, 263)');
  });
  it('never offers tap_at to a model that does not score', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('without vision never asks for pixels nor offers tap_at', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    expect(decisionExecutor({ model }).vision).toBeUndefined();
    await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: false });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('judges an assert with vision only on the pixels alone', async () => {
    const { model, requests } = scriptedDecision(() => ({ choice: 'holds' }));
    const fixture = context({ kind: 'assert', tree: BUTTONS, observation: { pixels: PIXELS }, vision: 'only' });
    const verdict = await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(requests[0]?.state).toMatchObject({ elements: [], page: { text: '' } });
    expect(requests[0]?.providerOptions).toMatchObject({ decision: { screenshot: { mediaType: 'image/png' } } });
  });
  it('keeps the transcript when the model call throws', async () => {
    const { model } = scriptedDecision(() => ({ choice: 'tap' }), { throws: new Error('boom') });
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(fixture.transcripts).toHaveLength(1);
    expect(fixture.transcripts[0]).toContain('"operation"');
  });
  it('rejects a non-boolean vision option', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    expect(() => decisionExecutor({ model, vision: 'only' as never })).toThrow(invalidConfig('vision'));
  });
});

describe('vision details', () => {
  /** A decodable white screenshot of the fixture viewport. */
  function whitePixels() {
    const png = new PNG({ width: 800, height: 600 });
    png.data.fill(255);
    return { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 };
  }
  it('sends the plain screenshot to the first look and draws the grid only on the zoomed look', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '4' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    const sent = (index: number) => {
      const options = requests[index]?.providerOptions as { decision: { screenshot: { data: string } } } | undefined;
      const png = PNG.sync.read(Buffer.from(options?.decision.screenshot.data ?? '', 'base64'));
      return { png, at: (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)] };
    };
    const full = sent(1);
    expect([full.png.width, full.png.height]).toEqual([800, 600]);
    expect(full.at(159, 300)).toEqual([255, 255, 255]);
    expect(full.at(2, 2)).toEqual([255, 255, 255]);
    expect(requests[1]?.questions['x']?.instructions).toContain('no grid is drawn on it');
    const zoomed = sent(2);
    expect([zoomed.png.width, zoomed.png.height]).toEqual([800, 800]);
    expect(zoomed.at(100, 300)).toEqual([255, 0, 255]);
    expect(zoomed.at(2, 2)).toEqual([0, 0, 0]);
    expect(zoomed.at(250, 250)).toEqual([255, 255, 255]);
    // Column 4 of 10 over 800px and row 4 of 8 over 600px is (360, 338); the 400px zoom around it starts at (160, 138)
    // and settles on its cell 4 center (385, 363).
    expect(requests[1]?.questions['x']?.instructions).toContain('The image is 800 pixels wide and 600 pixels tall');
    expect(requests[2]?.questions['x']?.instructions).toContain('2x zoom of a 400 by 400 pixel region');
    expect(fixture.actions.tapAt).toHaveBeenCalledWith({ x: 160 + 225, y: 138 + 225 });
  });
  it('never asks for pixels once a secret was filled, and offers no tap_at', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() }, pixelsTainted: true });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: false });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('judges a vision-only assert from the pixels when the tree is unavailable', async () => {
    const { model, requests } = scriptedDecision(() => ({ choice: 'holds' }));
    const fixture = context({ kind: 'assert', observation: { treeUnavailable: true, pixels: whitePixels() }, vision: 'only' });
    const verdict = await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(requests[0]?.state).toMatchObject({ elements: [], page: { text: '' } });
    const noPixels = context({ kind: 'assert', observation: { treeUnavailable: true }, vision: 'only' });
    expect(await decisionExecutor({ model, vision: true }).runStep(noPixels.ctx)).toMatchObject({ status: 'failed', errorCode: 'ASSERTION_INCONCLUSIVE' });
  });
  it('tells the model where a point tap landed', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '0' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    fixture.actions.tapAt.mockResolvedValue({ point: { x: 80, y: 80 }, target: { id: 'n9' }, summary: 'tapped button "Add"' });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    // Operation, coarse point, zoomed point, then the next operation.
    expect(requests.slice(0, 4).map((request) => Object.keys(request.questions))).toEqual([['operation'], ['x', 'y'], ['x', 'y'], ['operation']]);
    expect(requests[2]?.questions['x']?.instructions).toContain('2x zoom of a 400 by 400 pixel region');
    const state = requests[3]?.state as { recentActions: { note?: string }[] } | undefined;
    expect(state?.recentActions.at(-1)?.note).toBe('landed on listed control n9');
    expect(requests[3]?.questions['operation']?.instructions).toContain('(landed on listed control n9)');
  });
  it('lets the text model name the drawn control the point looks locate', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '0' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const text = scriptedOutputs([{ target: 'the 3 key on the keypad' }]);
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() }, model: text.model });
    await decisionExecutor({ model, textModel: text.model, vision: true }).runStep(fixture.ctx);
    expect(text.prompts).toHaveLength(1);
    expect(JSON.stringify(text.prompts[0])).toContain('Do the thing');
    expect(requests[1]?.questions['x']?.instructions).toContain('The control to tap now: the 3 key on the keypad');
    expect(requests[1]?.state).toMatchObject({ target: 'the 3 key on the keypad' });
    expect(fixture.turns[0]?.calls[0]).toMatch(/^tap the 3 key on the keypad at \(\d+, \d+\)$/);
    // Operation, sub-target, two looks, next operation: five model calls recorded.
    expect(fixture.usage).toHaveLength(5);
  });
  it('blocks a drag onto itself', async () => {
    const tree: ExecutorNode = { id: 'root', children: [
      { id: 'a', role: 'listitem', name: 'A' },
      { id: 'b', role: 'listitem', name: 'B' },
    ] };
    const { model } = scriptedDecision((id) => ({ choice: id === 'operation' ? 'drag' : '1' }));
    const fixture = context({ tree });
    expect(await decisionExecutor({ model }).runStep(fixture.ctx)).toMatchObject({ status: 'blocked', summary: expect.stringContaining('onto itself') });
    expect(fixture.actions.drag).not.toHaveBeenCalled();
  });
  it('refuses a secret named none', async () => {
    const { model } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'typeSecret' : (keys[0] ?? '') }));
    const fixture = context({ tree: FIELD, secrets: [{ name: 'none', purpose: 'password' }, { name: 'pin', purpose: 'password' }] });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', message: expect.stringContaining('collides') });
  });
});
