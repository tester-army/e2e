import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import type { ExecutorNode } from 'e2e';
import { decisionExecutor } from '../src/index.ts';
import { context } from './helpers.ts';

const BUTTONS: ExecutorNode = { id: 'root', children: [
  { id: 'save', role: 'button', name: 'Save' },
  { id: 'cancel', role: 'button', name: 'Cancel' },
]};

/** One Decisions API answer as the endpoint returns it. */
type WireAnswer =
  | { type: 'choice'; name: string; choice: string; confidence?: number; probabilities: { value: string; probability: number }[] }
  | { type: 'refusal'; name: string };

/** A Decisions API request body, as the OpenAI provider sends it. */
interface WireRequest {
  model: string;
  input: string;
  questions: { type: string; name: string; instructions: string; choices?: { value: string; description?: string }[] }[];
}

/** Unanimous distribution for the choice over the request's options. */
function unanimous(question: WireRequest['questions'][number], choice: string, confidence?: number): WireAnswer {
  const probabilities = (question.choices ?? []).map(({ value }) => ({ value, probability: value === choice ? 1 : 0 }));
  return { type: 'choice', name: question.name, choice, probabilities, ...(confidence === undefined ? {} : { confidence }) };
}

/**
 * The real OpenAI decision model over a scripted `/decisions` endpoint. The
 * resolver sees each request body and returns the wire answers.
 */
function openaiDecision(resolve: (request: WireRequest, call: number) => WireAnswer[]) {
  const requests: WireRequest[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    const answers = resolve(request, requests.length);
    requests.push(request);
    const body = { model: 'gpt-6-luna-2026-09-01', usage: { input_tokens: 321, output_tokens: 0 }, answers };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const model = createOpenAI({ apiKey: 'sk-test', fetch: fetch as typeof globalThis.fetch }).decisionModel('gpt-6-luna');
  return { model, requests };
}

describe('OpenAI Decisions API', () => {
  it('is accepted at config load', () => {
    const { model } = openaiDecision(() => []);
    expect(decisionExecutor({ model }).name).toBe('decision');
  });
  it('taps through the wire shape and reads native confidence', async () => {
    const { model, requests } = openaiDecision((request, call) =>
      request.questions.map((question) => {
        if (question.name === 'operation') {
          return call === 0
            ? { type: 'choice', name: 'operation', choice: 'tap', confidence: 0.93, probabilities: (question.choices ?? []).map(({ value }) => ({ value, probability: value === 'tap' ? 0.95 : value === 'done' ? 0.05 : 0 })) }
            : unanimous(question, 'done', 0.9);
        }
        if (question.name === 'verdict') return unanimous(question, 'holds', 0.9);
        return unanimous(question, question.choices?.[0]?.value ?? '', 0.6);
      }),
    );
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minProbability: 0.9, minConfidence: 0.5 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.actions.tap).toHaveBeenCalledTimes(1);
    const first = requests[0];
    expect(first?.model).toBe('gpt-6-luna');
    expect(JSON.parse(first?.input ?? '')).toMatchObject({ goal: 'Do the thing', elements: expect.any(Array) });
    expect(first?.questions.map((question) => question.name)).toEqual(['operation', 'tap_target']);
    expect(first?.questions[1]?.choices).toEqual([
      { value: '1', description: JSON.stringify({ element: 'Save', role: 'button' }) },
      { value: '2', description: JSON.stringify({ element: 'Cancel', role: 'button' }) },
    ]);
    expect(fixture.usage[0]).toMatchObject({ provider: 'openai.decision', modelId: 'gpt-6-luna-2026-09-01', inputTokens: 321 });
    expect(fixture.turns[0]?.outcome).toContain('op p=0.950, target p=1.000');
  });
  it('blocks under the confidence gate when the endpoint reports none', async () => {
    const { model } = openaiDecision((request) => request.questions.map((question) => unanimous(question, question.name === 'operation' ? 'tap' : (question.choices?.[0]?.value ?? ''))));
    const fixture = context({ tree: BUTTONS });
    const verdict = await decisionExecutor({ model, minConfidence: 0.5 }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED' });
    expect(fixture.actions.tap).not.toHaveBeenCalled();
  });
  it('names a refusal as MODEL_OUTPUT_INVALID', async () => {
    const { model } = openaiDecision((request) => request.questions.map((question) =>
      question.name === 'operation' ? { type: 'refusal', name: 'operation' } : unanimous(question, question.choices?.[0]?.value ?? '')));
    const fixture = context({ tree: BUTTONS });
    await expect(decisionExecutor({ model }).runStep(fixture.ctx)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID', message: 'The decision model refused to answer a question.',
    });
  });
});
