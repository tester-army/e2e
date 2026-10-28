/**
 * The request prefix a step sends, turn after turn, as Anthropic's API reads
 * it: Claude Opus 5.5, Sonnet 5.5, and Fable 5.1 bind each thinking block to
 * the system prompt and every message before it, and reject a replayed
 * block whose prefix changed. The real `@ai-sdk/anthropic` provider
 * runs here over a fake fetch that records every request body and answers
 * with canned replies carrying signed thinking blocks: no key, no network,
 * and the assertions are on the wire format, not on the SDK's messages.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolLoopExecutor } from '../../src/agent/tool-loop.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig, ModelInstance } from '../../src/types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

/** A real fixture graph with an in-memory engine and no runner process. */
function runtime(engine: EngineHandle, overrides: Partial<E2EConfig> = {}) {
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

/**
 * A page of `rows` lines whose every line changes with the variant the
 * script sets, as a navigation changes a page: a look at a new variant goes
 * out as a whole new screen. Six hundred long rows make a screen of some
 * 50 KB, past the budget of superseded screens the transcript keeps; twenty
 * short ones never reach it. The first row is a button, so the opening
 * prompt looks once.
 */
function changingScreen(rows: number, variant: () => number): EngineHandle {
  return defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () =>
      snapshot(
        Array.from({ length: rows }, (_, i) => ({
          ref: { id: `n${String(i)}`, revision: '' },
          role: i === 0 ? 'button' : 'text',
          name: `v${String(variant())} row ${String(i)} ${rows > 100 ? 'x'.repeat(90) : ''}`,
        })),
      ),
  });
}

/** One content block of a Messages API request, as far as the assertions read it. */
interface Block {
  readonly type: string;
  readonly text?: string;
  readonly signature?: string;
}

/** A Messages API request body, as far as the assertions read it. */
interface Body {
  readonly system?: unknown;
  readonly tools?: readonly { readonly name: string }[];
  readonly tool_choice?: { readonly type: string };
  readonly messages: readonly { readonly role: string; readonly content: string | readonly Block[] }[];
}

/** Every Messages API reply of a step: a signed thinking block, then one tool call. */
type Reply = (accepted: number) => { readonly name: string; readonly input: Record<string, unknown> };

const observe = { name: 'observe', input: {} };
const conclude = { name: 'complete_step', input: { status: 'passed', summary: 'done' } };

/**
 * The real Anthropic provider over a fetch that records each request body
 * and answers from the script. Every forced tool choice is accepted as sent,
 * so the test reads the same whether the provider sends it or downgrades it.
 */
function capturingModel(reply: Reply): { model: ModelInstance; requests: Body[] } {
  const requests: Body[] = [];
  const fetchFake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    const n = requests.length;
    const call = reply(n);
    return new Response(
      JSON.stringify({
        id: `msg_${String(n)}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          { type: 'thinking', thinking: '', signature: `sig-${String(n)}` },
          { type: 'tool_use', id: `toolu_${String(n)}`, name: call.name, input: call.input },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const model = createAnthropic({ apiKey: 'test-key', fetch: fetchFake })('claude-opus-5-5') as unknown as ModelInstance;
  return { model, requests };
}

/**
 * What `@ai-sdk/anthropic` does for the models that reject forced tool use: a
 * forced choice goes out as `auto` with an `unsupported` call warning, which
 * the loop reads as the signal to continue the step in `auto`.
 */
function downgradingForcedToolChoice(base: ModelInstance): ModelInstance {
  type Options = { readonly toolChoice?: { readonly type: string } };
  type Result = { readonly warnings?: readonly unknown[] };
  const target = base as unknown as { doGenerate: (options: Options) => Promise<Result> };
  return new Proxy(base, {
    get(object, property) {
      if (property !== 'doGenerate') {
        const value = Reflect.get(object, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
      }
      return async (options: Options): Promise<Result> => {
        const forced = options.toolChoice !== undefined && options.toolChoice.type !== 'auto' && options.toolChoice.type !== 'none';
        const result = await target.doGenerate.call(object, forced ? { ...options, toolChoice: { type: 'auto' } } : options);
        if (!forced) return result;
        return { ...result, warnings: [...(result.warnings ?? []), { type: 'unsupported', feature: 'toolChoice', details: 'using auto' }] };
      };
    },
  }) as ModelInstance;
}

function firstUserText(body: Body): string {
  const content = body.messages[0]!.content;
  return typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('');
}

/** `messages.<i>.content.<j>=<signature>` for every thinking block the request replays. */
function replayedThinking(body: Body): string[] {
  return body.messages.flatMap((message, i) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((block, j) => (block.type === 'thinking' ? [`messages.${String(i)}.content.${String(j)}=${block.signature ?? ''}`] : [])),
  );
}

describe('the request prefix of an agent step on Anthropic', () => {
  beforeAll(() => {
    (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
  });
  afterAll(() => {
    delete (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS;
  });

  it('keeps the system prompt identical on every turn, the switch to auto included', async () => {
    let variant = 1;
    const { model, requests } = capturingModel((n) => {
      variant = n + 1;
      return n <= 3 ? observe : conclude;
    });
    const { fixtures, steps } = runtime(changingScreen(20, () => variant), {
      agents: { default: { model: downgradingForcedToolChoice(model) } },
    });

    await fixtures.agent.act('look around, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(requests).toHaveLength(4);
    // Every request went out as auto: the provider downgraded the first, the loop sent the rest that way.
    expect(requests.map((body) => body.tool_choice?.type)).toEqual(['auto', 'auto', 'auto', 'auto']);
    const [first] = requests as [Body];
    expect(JSON.stringify(first.system)).toContain('Reply with tool calls only');
    expect(requests.map((body) => JSON.stringify(body.system))).toEqual(Array<string>(4).fill(JSON.stringify(first.system)));
    expect(requests.map((body) => body.tools!.map((entry) => entry.name).join(','))).toEqual(Array<string>(4).fill('observe,screenshot,complete_step'));
    // Nothing before any block changed, so every block is replayed.
    expect(replayedThinking(requests[3]!)).toEqual(['messages.1.content.0=sig-1', 'messages.3.content.0=sig-2', 'messages.5.content.0=sig-3']);
  });

  it('stops replaying the thinking from a message an elision rewrote, and keeps the thinking produced after it', async () => {
    // The opening screen, a whole new one on the first look, the same one on the second.
    let variant = 1;
    const { model, requests } = capturingModel((n) => {
      if (n === 1) variant = 2;
      return n <= 2 ? observe : conclude;
    });
    const { fixtures, steps } = runtime(changingScreen(600, () => variant), { agents: { default: { model } } });

    await fixtures.agent.act('look around twice, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(requests).toHaveLength(3);
    const [first, second, third] = requests as [Body, Body, Body];
    expect(firstUserText(first)).toContain('Current screen (revision');
    // The second request elided the opening screen at messages.0: the block
    // produced under the whole screen is not sent again.
    expect(firstUserText(second)).toContain('[earlier screen elided');
    expect(replayedThinking(second)).toEqual([]);
    // The third request leaves messages.0 as the second sent it, so the block
    // produced under the elided screen is valid and goes out; the first is still gone.
    expect(firstUserText(third)).toBe(firstUserText(second));
    expect(replayedThinking(third)).toEqual(['messages.3.content.0=sig-2']);
    expect(steps.all()[0]!.turns!.some((turn) => turn.outcome.includes('message 1 was rewritten, so the reasoning after it is not sent again'))).toBe(true);
  });

  it('notices a message a custom executor edits in place, not only one it replaces', async () => {
    const look = { name: 'look', input: {} };
    const { model, requests } = capturingModel((n) => (n <= 2 ? look : conclude));
    const executor = createToolLoopExecutor({
      name: 'editing',
      tools: () => ({ look: tool({ description: 'Looks.', inputSchema: z.object({}), execute: async () => 'looked' }) }),
      buildPrompt: () => 'Execute this test step: look twice, then conclude.',
      // Before the third turn, the opening message is edited through the
      // object the loop handed over, and the same array comes back.
      prepareMessages: (messages, { stepNumber }) => {
        const opening = messages[0];
        if (stepNumber === 2 && opening?.role === 'user') opening.content = 'Execute this test step: look twice, then conclude. [edited in place]';
        return messages;
      },
    });
    const { fixtures, steps } = runtime(changingScreen(20, () => 1), { agents: { default: { executor, model } } });

    await fixtures.agent.act('look twice, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(replayedThinking(requests[1]!)).toEqual(['messages.1.content.0=sig-1']);
    expect(firstUserText(requests[2]!)).toContain('[edited in place]');
    expect(replayedThinking(requests[2]!)).toEqual([]);
  });

  it('notices a tool result a custom executor edits in place, below the part', async () => {
    const look = { name: 'look', input: {} };
    const { model, requests } = capturingModel((n) => (n <= 2 ? look : conclude));
    const executor = createToolLoopExecutor({
      name: 'editing',
      tools: () => ({ look: tool({ description: 'Looks.', inputSchema: z.object({}), execute: async () => 'looked' }) }),
      buildPrompt: () => 'Execute this test step: look twice, then conclude.',
      // Before the third turn, the first tool result's output is replaced
      // through the part object the loop handed over.
      prepareMessages: (messages, { stepNumber }) => {
        const result = messages[2];
        if (stepNumber === 2 && result?.role === 'tool' && result.content[0]?.type === 'tool-result') {
          result.content[0].output = { type: 'text', value: 'looked [edited in place]' };
        }
        return messages;
      },
    });
    const { fixtures, steps } = runtime(changingScreen(20, () => 1), { agents: { default: { executor, model } } });

    await fixtures.agent.act('look twice, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages[2])).toContain('looked [edited in place]');
    // The edit sits at messages.2, so the block before it stays and the one after it goes.
    expect(replayedThinking(requests[2]!)).toEqual(['messages.1.content.0=sig-1']);
  });

  it('keeps every reasoning part when a custom executor clones the history each turn', async () => {
    const look = { name: 'look', input: {} };
    const { model, requests } = capturingModel((n) => (n <= 2 ? look : conclude));
    const executor = createToolLoopExecutor({
      name: 'cloning',
      tools: () => ({ look: tool({ description: 'Looks.', inputSchema: z.object({}), execute: async () => 'looked' }) }),
      // The opening message carries bytes too, which a clone copies into new objects.
      buildPrompt: () => [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Execute this test step: look twice, then conclude.' },
            { type: 'file', data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' },
          ],
        },
      ],
      prepareMessages: (messages) => structuredClone(messages),
    });
    const { fixtures, steps } = runtime(changingScreen(20, () => 1), { agents: { default: { executor, model } } });

    await fixtures.agent.act('look twice, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(requests).toHaveLength(3);
    // Equal content in new objects is no edit: nothing is dropped.
    expect(replayedThinking(requests[2]!)).toEqual(['messages.1.content.0=sig-1', 'messages.3.content.0=sig-2']);
    expect(steps.all()[0]!.turns!.some((turn) => turn.outcome.includes('was rewritten'))).toBe(false);
  });
});

describe('the request prefix of an agent step on other providers', () => {
  it('replays every reasoning part after an elision: nothing binds them to the prefix', async () => {
    let variant = 1;
    const model = installFakeLoopModel(({ turn }) => {
      variant = turn + 1;
      return {
        reasoning: `thought ${String(turn)}`,
        toolCalls: turn <= 2 ? [{ toolName: 'observe', input: {} }] : [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }],
      };
    });
    const { fixtures, steps } = runtime(changingScreen(600, () => variant), { agents: { default: { model } } });

    await fixtures.agent.act('look around twice, then conclude');

    expect(steps.all()[0]!.status).toBe('passed');
    expect(loopCalls).toHaveLength(3);
    expect(loopCalls[1]!.prompt).toContain('[earlier screen elided');
    expect(loopCalls.map((call) => call.reasoningParts)).toEqual([0, 1, 2]);
  });
});
