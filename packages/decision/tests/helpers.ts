import type { LanguageModel } from 'ai';
import type { DecisionExecutorOptions } from '../src/index.ts';
import type { ExecutorActions, ExecutorModelCall, ExecutorNode, ExecutorObservation, ExecutorPixels, JsonValue, StepExecutorContext, StepTurn } from 'e2e';
import { expect, vi } from 'vitest';
import { PNG } from 'pngjs';
/** One scripted answer: the choice, its distribution, and the reported confidence. */
export interface ScriptedAnswer {
  readonly choice: string;
  readonly probabilities?: Record<string, number>;
  readonly confidence?: number;
  /** Omit `probabilities` from the answer entirely. */
  readonly bare?: true;
  /** For a score question: the probability-weighted level; defaults to the chosen level. */
  readonly score?: number;
}
/** A recorded decide call: the state and the question map the executor sent. */
export interface EvalRequest {
  /** The JSON part of the state. */
  readonly state: unknown;
  /** The file parts of the state, as the SDK hands them to the model. */
  readonly files: readonly { readonly mediaType: string; readonly data: unknown }[];
  readonly questions: Record<string, { type: string; instructions?: string; criteria: unknown }>;
  /** Present only when the executor sent provider options. */
  readonly providerOptions?: unknown;
}
/** The model shapes the executor accepts: a decision model, or a deprecated evaluation model. */
type AcceptedModel = DecisionExecutorOptions['model'];
type DecideCall = Parameters<Extract<AcceptedModel, { doDecide: unknown }>['doDecide']>[0];
type DecideResult = Awaited<ReturnType<Extract<AcceptedModel, { doDecide: unknown }>['doDecide']>>;
/**
 * A scripted decision model: records requests and answers every choice
 * question through one resolver. Unspecified probabilities become a
 * unanimous distribution for the choice, which core validation accepts.
 * `legacy` builds the deprecated evaluation model shape (`doEvaluate`).
 */
export function scriptedDecision(resolve: (id: string, keys: string[], call: number) => ScriptedAnswer, options?: { supported?: readonly ('choice' | 'score' | 'boolean')[]; throws?: unknown; legacy?: true }): { model: AcceptedModel; requests: EvalRequest[] } {
  const requests: EvalRequest[] = [];
  const respond = async (call: DecideCall): Promise<DecideResult> => {
    if (options?.throws !== undefined) throw options.throws;
    const index = requests.length;
    const questions: EvalRequest['questions'] = {};
    const answers: Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number> } | { type: 'score'; score: number; probabilities: Record<string, number> }> = {};
    const confidence: Record<string, number> = {};
    for (const [id, question] of Object.entries(call.questions)) {
      if (question.type === 'score') {
        const levels = (question.criteria as readonly unknown[]).map((_, level) => String(level));
        questions[id] = { type: question.type, instructions: String(question.instructions), criteria: question.criteria };
        const answer = resolve(id, levels, index);
        const score = answer.score ?? Number(answer.choice);
        const low = Math.floor(score);
        const high = Math.min(levels.length - 1, low + 1);
        const weightHigh = score - low;
        const probabilities = answer.probabilities ?? Object.fromEntries(levels.map((level) => [level, level === String(low) ? 1 - weightHigh : level === String(high) ? weightHigh : 0]));
        answers[id] = { type: 'score', score, probabilities };
        if (answer.confidence !== undefined) confidence[id] = answer.confidence;
        continue;
      }
      if (question.type !== 'choice') throw new Error('scripted model answers choice and score questions only');
      const criteria = question.criteria as Record<string, unknown>;
      questions[id] = { type: question.type, instructions: String(question.instructions), criteria };
      const keys = Object.keys(criteria);
      const answer = resolve(id, keys, index);
      if (answer.bare === true) {
        answers[id] = { type: 'choice', choice: answer.choice } as (typeof answers)[string];
      } else {
        answers[id] = { type: 'choice', choice: answer.choice, probabilities: answer.probabilities ?? Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 1 : 0])) };
      }
      if (answer.confidence !== undefined) confidence[id] = answer.confidence;
    }
    const parts = call.state as readonly ({ type: 'json'; value: unknown } | { type: 'file'; mediaType: string; data: { type: 'data'; data: unknown } } | { type: 'text' })[];
    const state = parts.find((part) => part.type === 'json')?.value;
    const files = parts.flatMap((part) => (part.type === 'file' ? [{ mediaType: part.mediaType, data: part.data.data }] : []));
    requests.push({ state, files, questions, ...(call.providerOptions === undefined ? {} : { providerOptions: call.providerOptions }) });
    return { answers, warnings: [], usage: { inputTokens: 10, outputTokens: 0 }, rounding: { probabilityDecimals: 6, scoreDecimals: 6 }, providerMetadata: { scripted: { confidence } }, response: { modelId: 'scripted-1' } };
  };
  const base = {
    specificationVersion: 'v4' as const,
    provider: 'scripted',
    modelId: 'scripted-1',
    supportedQuestionTypes: [...(options?.supported ?? ['choice' as const])],
  };
  const model: AcceptedModel = options?.legacy === true ? { ...base, doEvaluate: respond } : { ...base, doDecide: respond };
  return { model, requests };
}
/** A scripted language model: returns queued texts as JSON through real generateText. */
export function scriptedText(texts: (string | null)[]): { model: Exclude<LanguageModel, string>; prompts: unknown[] } {
  return scriptedOutputs(texts.map((text) => ({ text })));
}
/** A scripted language model that answers each call with the next queued JSON value. */
export function scriptedOutputs(values: unknown[]): { model: Exclude<LanguageModel, string>; prompts: unknown[] } {
  const prompts: unknown[] = [];
  const queue = [...values];
  const model = {
    specificationVersion: 'v4',
    provider: 'scripted-text',
    modelId: 'scripted-text-1',
    doGenerate: async (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      // Exhaustion throws: queue an explicit null for the goal-supplies-no-value case.
      const value = queue.shift();
      if (value === undefined) throw new Error('scriptedText exhausted: the executor asked for more field values than queued.');
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
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
  vision?: StepExecutorContext['step']['vision'];
  pixelsTainted?: boolean;
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
  const observation: ExecutorObservation = {
    revision: '1', text: '#name textbox', truncated: false,
    viewport: { width: 800, height: 600 }, ...(options.observation?.treeUnavailable === true ? {} : { tree }), ...options.observation,
  };
  const observe = vi.fn<StepExecutorContext['observe']>().mockResolvedValue(observation);
  const usage: ExecutorModelCall[] = [];
  const turns: StepTurn[] = [];
  const transcripts: string[] = [];
  const ctx: StepExecutorContext = {
    step: { kind: options.kind ?? 'act', index: 0, instruction: 'Do the thing', params: options.params, secrets: options.secrets ?? [{ name: 'password', purpose: 'password' }], ...(options.vision === undefined ? {} : { vision: options.vision }) },
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    signal, target: { name: 'web', platform: 'web', verbs: new Set(options.verbs ?? (Object.keys(actions) as (keyof ExecutorActions)[])) },
    model: options.model as StepExecutorContext['model'], providerOptions: undefined,
    ledger: options.ledger ?? '', agentContext: undefined,
    actions, observe, pixelsTainted: options.pixelsTainted ?? false,
    attachTranscript: (text) => { transcripts.push(text); }, attachTurns: (seen) => { turns.push(...seen); }, attachScreenshot: async () => 'screenshot',
    budgets: { maxActions: 25, maxModelCalls: options.maxModelCalls ?? 25, remainingMs: () => 60000, actionsUsed: () => 0, recordModelCall: (call) => { usage.push(call ?? {}); }, runTool: (_call, body) => body() },
    ...(options.replayedPrefix === undefined ? {} : { replayedPrefix: options.replayedPrefix }),
  };
  return { ctx, usage, observe, actions, turns, transcripts };
}

/** Matches the ConfigurationError a factory throws at config load. */
export function invalidConfig(message: string): object {
  return expect.objectContaining({ name: 'ConfigurationError', code: 'INVALID_CONFIG', message: expect.stringContaining(message) });
}
/** Two buttons: the smallest screen with a target question. */
export const BUTTONS: ExecutorNode = { id: 'root', children: [
  { id: 'save', role: 'button', name: 'Save' },
  { id: 'cancel', role: 'button', name: 'Cancel' },
]};
/** A field and a button: the smallest screen that types. */
export const FIELD: ExecutorNode = { id: 'root', children: [
  { id: 'name', role: 'textbox', name: 'Name', value: '' },
  { id: 'save', role: 'button', name: 'Save' },
]};
/** A decodable white screenshot of the fixture viewport. */
export function whitePixels(): ExecutorPixels {
  const png = new PNG({ width: 800, height: 600 });
  png.data.fill(255);
  return { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png', width: 800, height: 600, scale: 1, maskedRegionCount: 0 };
}
