import type { Experimental_EvaluationModelV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import type { ExecutorActions, ExecutorModelCall, ExecutorNode, ExecutorObservation, JsonValue, StepExecutorContext, StepTurn } from 'e2e';
import { vi } from 'vitest';
/** One scripted answer: the choice, its distribution, and the reported confidence. */
export interface ScriptedAnswer {
  readonly choice: string;
  readonly probabilities?: Record<string, number>;
  readonly confidence?: number;
  /** Omit `probabilities` from the answer entirely. */
  readonly bare?: true;
}
/** A recorded evaluate call: the state and the question map the executor sent. */
export interface EvalRequest {
  readonly state: unknown;
  readonly questions: Record<string, { type: string; criteria: unknown }>;
}
/**
 * A scripted evaluation model: records requests and answers every choice
 * question through one resolver. Unspecified probabilities become a
 * unanimous distribution for the choice, which core validation accepts.
 */
export function scriptedEvaluation(resolve: (id: string, keys: string[], call: number) => ScriptedAnswer, options?: { supported?: readonly ('choice' | 'score' | 'boolean')[]; throws?: unknown }): { model: Experimental_EvaluationModelV4; requests: EvalRequest[] } {
  const requests: EvalRequest[] = [];
  const model: Experimental_EvaluationModelV4 = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted-1',
    supportedQuestionTypes: [...(options?.supported ?? ['choice'])],
    doEvaluate: async (call) => {
      if (options?.throws !== undefined) throw options.throws;
      const index = requests.length;
      const questions: EvalRequest['questions'] = {};
      const answers: Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number> }> = {};
      const confidence: Record<string, number> = {};
      for (const [id, question] of Object.entries(call.questions)) {
        if (question.type !== 'choice') throw new Error('scripted model answers choice questions only');
        const criteria = question.criteria as Record<string, unknown>;
        questions[id] = { type: question.type, criteria };
        const keys = Object.keys(criteria);
        const answer = resolve(id, keys, index);
        if (answer.bare === true) {
          answers[id] = { type: 'choice', choice: answer.choice } as (typeof answers)[string];
        } else {
          answers[id] = { type: 'choice', choice: answer.choice, probabilities: answer.probabilities ?? Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 1 : 0])) };
        }
        if (answer.confidence !== undefined) confidence[id] = answer.confidence;
      }
      requests.push({ state: call.state, questions });
      return { answers, warnings: [], usage: { inputTokens: 10, outputTokens: 0 }, providerMetadata: { scripted: { confidence } }, response: { modelId: 'scripted-1' } };
    },
  };
  return { model, requests };
}
/** A scripted language model: returns queued texts as JSON through real generateText. */
export function scriptedText(texts: (string | null)[]): { model: Exclude<LanguageModel, string>; prompts: unknown[] } {
  const prompts: unknown[] = [];
  const queue = [...texts];
  const model = {
    specificationVersion: 'v4',
    provider: 'scripted-text',
    modelId: 'scripted-text-1',
    doGenerate: async (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      // Exhaustion throws: queue an explicit null for the goal-supplies-no-value case.
      const text = queue.shift();
      if (text === undefined) throw new Error('scriptedText exhausted: the executor asked for more field values than queued.');
      return {
        content: [{ type: 'text', text: JSON.stringify({ text }) }],
        finishReason: { unified: 'stop' as const },
        usage: { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  } as unknown as Exclude<LanguageModel, string>;
  return { model, prompts };
}
export function context(options: {
  kind?: 'act' | 'assert';
  tree?: ExecutorNode;
  observation?: Partial<ExecutorObservation>;
  maxModelCalls?: number;
  model?: unknown;
  ledger?: string;
  replayedPrefix?: StepExecutorContext['replayedPrefix'];
  verbs?: (keyof ExecutorActions)[];
  signal?: AbortSignal;
  params?: Readonly<Record<string, JsonValue>>;
  secrets?: StepExecutorContext['step']['secrets'];
} = {}) {
  const signal = options.signal ?? new AbortController().signal;
  const noop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const actions = {
    tap: vi.fn<ExecutorActions['tap']>().mockResolvedValue(undefined),
    type: vi.fn<ExecutorActions['type']>().mockResolvedValue(undefined),
    typeSecret: vi.fn<ExecutorActions['typeSecret']>().mockResolvedValue(undefined),
    press: vi.fn<ExecutorActions['press']>().mockResolvedValue(undefined),
    select: vi.fn<ExecutorActions['select']>().mockResolvedValue(undefined),
    check: vi.fn<ExecutorActions['check']>().mockResolvedValue(undefined),
    scroll: vi.fn<ExecutorActions['scroll']>().mockResolvedValue(undefined),
    back: vi.fn<ExecutorActions['back']>().mockResolvedValue(undefined),
    navigate: vi.fn<ExecutorActions['navigate']>().mockResolvedValue(undefined),
    doubleTap: noop, longPress: noop, secondaryTap: noop, hover: noop,
    drag: noop, scrollTo: noop, scrollUntil: noop, upload: noop,
    typeText: noop, pressKey: noop, dismissKeyboard: noop,
    tapAt: vi.fn<ExecutorActions['tapAt']>().mockImplementation(async (point) => ({ point, summary: 'tap' })),
    hoverAt: vi.fn<ExecutorActions['hoverAt']>().mockImplementation(async (point) => ({ point, summary: 'hover' })),
    hitTest: vi.fn<ExecutorActions['hitTest']>().mockImplementation(async (point) => ({ point, summary: 'hit' })),
  };
  const tree = options.tree ?? { id: 'root', children: [{ id: 'name', role: 'textbox', name: 'Name', value: '' }] };
  const observe = vi.fn<StepExecutorContext['observe']>().mockResolvedValue({
    revision: '1', text: '#name textbox', truncated: false,
    viewport: { width: 800, height: 600 }, tree, ...options.observation,
  });
  const usage: ExecutorModelCall[] = [];
  const turns: StepTurn[] = [];
  const transcripts: string[] = [];
  const ctx: StepExecutorContext = {
    step: { kind: options.kind ?? 'act', index: 0, instruction: 'Do the thing', params: options.params, secrets: options.secrets ?? [{ name: 'password', purpose: 'password' }] },
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    signal, target: { name: 'web', platform: 'web', verbs: new Set(options.verbs ?? (Object.keys(actions) as (keyof ExecutorActions)[])) },
    model: options.model as StepExecutorContext['model'], providerOptions: undefined,
    ledger: options.ledger ?? '', agentContext: undefined,
    actions, observe, pixelsTainted: false,
    attachTranscript: (text) => { transcripts.push(text); }, attachTurns: (seen) => { turns.push(...seen); }, attachScreenshot: async () => 'screenshot',
    budgets: { maxActions: 25, maxModelCalls: options.maxModelCalls ?? 25, remainingMs: () => 60000, actionsUsed: () => 0, recordModelCall: (call) => { usage.push(call ?? {}); }, runTool: (_call, body) => body() },
    ...(options.replayedPrefix === undefined ? {} : { replayedPrefix: options.replayedPrefix }),
  };
  return { ctx, usage, observe, actions, turns, transcripts };
}
