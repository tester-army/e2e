import { describe, expect, it } from 'vitest';
import {
  AiTraceCollector,
  AiTraceRecorder,
  redactAiTraceDocument,
  registerAiTraceRecorder,
  stringify,
  withAiTraceScope,
  withAiTraceStep,
} from '../../src/internal/ai-trace.ts';
import { SecretLedger } from '../../src/internal/redact.ts';

const SCOPE = { test: 'todos › adds one', testId: 't1', target: 'web', agent: 'default', attempt: 0 };

/** Drives one two-step generation through the recorder the way the SDK does. */
async function generation(recorder: AiTraceRecorder, callId: string, options: { fail?: boolean } = {}) {
  const t = recorder.telemetry;
  const fire = <E>(callback: ((event: E) => unknown) | undefined, event: E) => callback?.(event);
  await fire(t.onStart, { callId, operationId: 'ai.generateText' } as never);
  await fire(t.onStepStart, {
    callId,
    stepNumber: 0,
    provider: 'gateway',
    modelId: 'google/gemini-3-flash',
    instructions: 'You are a testing agent.',
    messages: [{ role: 'user', content: 'Execute this test step: add a todo' }],
  } as never);
  await fire(t.onLanguageModelCallStart, {
    callId,
    instructions: 'You are a testing agent.',
    messages: [{ role: 'user', content: 'Execute this test step: add a todo (compacted)' }],
    tools: [
      {
        type: 'function',
        name: 'tap',
        description: 'Tap or click one node.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
      },
    ],
    toolChoice: { type: 'required' },
  } as never);
  await fire(t.onLanguageModelCallEnd, { callId, performance: { responseTimeMs: 321 } } as never);
  if (options.fail === true) {
    await fire(t.onError, { callId, error: new Error('provider exploded') });
    return;
  }
  await fire(t.onStepEnd, {
    callId,
    stepNumber: 0,
    content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'tap', input: { target: 'n1' } }],
    finishReason: 'tool-calls',
    usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 40 } },
    providerMetadata: { gateway: { cost: '0.0001' } },
    response: {
      id: 'r1',
      modelId: 'google/gemini-3-flash',
      timestamp: new Date(0),
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'tap', input: { target: 'n1' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'tap', output: { type: 'text', value: 'Tapped #n1.' } }] },
      ],
    },
  } as never);
  await fire(t.onEnd, { callId } as never);
}

describe('AiTraceRecorder', () => {
  it('records one run per agent step and one step per model round trip', async () => {
    const recorder = new AiTraceRecorder();
    await withAiTraceScope(SCOPE, () =>
      withAiTraceStep('agent.act', 'add a todo', () => generation(recorder, 'call-1')),
    );
    const { runs, steps } = recorder.drain();
    expect(runs).toHaveLength(1);
    expect(steps).toHaveLength(1);
    const run = runs[0]!;
    expect(run.function_id).toBe('todos › adds one · agent.act "add a todo"');
    expect(run.parent_run_id).toBeNull();
    expect(run.e2e).toEqual({ ...SCOPE, api: 'agent.act', label: 'add a todo' });
    const step = steps[0]!;
    expect(step.run_id).toBe(run.id);
    expect(step.step_number).toBe(1);
    expect(step.model_id).toBe('google/gemini-3-flash');
    expect(step.provider).toBe('gateway');
    expect(step.duration_ms).toBe(321);
    expect(step.error).toBeNull();
  });

  it('writes the prompt as sent, with the system prompt in front and tool schemas attached', async () => {
    const recorder = new AiTraceRecorder();
    await generation(recorder, 'call-1');
    const step = recorder.drain().steps[0]!;
    const input = JSON.parse(step.input) as {
      prompt: { role: string; content: string }[];
      tools: { name: string; description: string; parameters: unknown }[];
      toolChoice: unknown;
    };
    expect(input.prompt.map((message) => message.role)).toEqual(['system', 'user']);
    expect(input.prompt[0]!.content).toBe('You are a testing agent.');
    // The model-call view (after prepareStep) supersedes the step-start one.
    expect(input.prompt[1]!.content).toContain('(compacted)');
    expect(input.tools).toEqual([
      {
        name: 'tap',
        description: 'Tap or click one node.',
        parameters: { type: 'object', properties: { target: { type: 'string' } } },
      },
    ]);
    expect(input.toolChoice).toEqual({ type: 'required' });
  });

  it('writes the response, usage, and provider metadata of a finished step', async () => {
    const recorder = new AiTraceRecorder();
    await generation(recorder, 'call-1');
    const step = recorder.drain().steps[0]!;
    const output = JSON.parse(step.output!) as {
      finishReason: string;
      response: { messages: { role: string }[] };
      providerMetadata: { gateway: { cost: string } };
    };
    expect(output.finishReason).toBe('tool-calls');
    expect(output.response.messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(output.providerMetadata.gateway.cost).toBe('0.0001');
    expect(JSON.parse(step.usage!)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 40 },
    });
  });

  it('redacts registered secret values from the input, output, and error it keeps', async () => {
    // A quote in the value: its JSON-string form differs from the raw one, and both must go.
    const secret = 'tok-9f3a"x';
    const ledger = new SecretLedger([['token', secret]]);
    const recorder = new AiTraceRecorder({ redact: ledger.redact });
    const t = recorder.telemetry;
    const fire = <E>(callback: ((event: E) => unknown) | undefined, event: E) => callback?.(event);
    await fire(t.onStart, { callId: 'echo', operationId: 'ai.generateText' } as never);
    await fire(t.onStepStart, {
      callId: 'echo',
      stepNumber: 0,
      provider: 'gateway',
      modelId: 'm',
      instructions: 'You are a testing agent.',
      messages: [{ role: 'user', content: `use ${secret}` }],
    } as never);
    await fire(t.onStepEnd, {
      callId: 'echo',
      stepNumber: 0,
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'type', input: { target: 'n2', text: secret } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
      providerMetadata: { gateway: { echo: secret } },
      response: { id: 'r1', modelId: 'm', messages: [{ role: 'assistant', content: `the key is ${secret}` }] },
    } as never);
    await fire(t.onEnd, { callId: 'echo' } as never);
    await fire(t.onStart, { callId: 'boom', operationId: 'ai.generateText' } as never);
    await fire(t.onStepStart, {
      callId: 'boom',
      stepNumber: 0,
      provider: 'gateway',
      modelId: 'm',
      instructions: 'You are a testing agent.',
      messages: [],
    } as never);
    await fire(t.onError, { callId: 'boom', error: new Error(`rejected ${secret}`) });

    const [closed, failed] = recorder.drain().steps;
    for (const column of [closed!.input, closed!.output!, failed!.error!]) {
      expect(column).not.toContain('tok-9f3a');
      expect(column).toContain('<secret:token>');
    }
    const output = JSON.parse(closed!.output!) as {
      content: { input: { text: string } }[];
      providerMetadata: { gateway: { echo: string } };
      response: { messages: { content: string }[] };
    };
    expect(output.content[0]!.input.text).toBe('<secret:token>');
    expect(output.providerMetadata.gateway.echo).toBe('<secret:token>');
    expect(output.response.messages[0]!.content).toBe('the key is <secret:token>');
    expect(failed!.error).toBe('rejected <secret:token>');
  });

  it('redacts string leaves before serialization, so a secret that is JSON punctuation or a key name leaves every column parseable', async () => {
    const ledger = new SecretLedger([
      ['brace', '{'],
      ['key', 'target'],
    ]);
    const recorder = new AiTraceRecorder({ redact: ledger.redact });
    await withAiTraceScope({ ...SCOPE, test: 'opens {' }, () =>
      withAiTraceStep('agent.act', 'find the target', () => generation(recorder, 'call-1')),
    );
    const { runs, steps } = recorder.drain();
    expect(runs[0]!.function_id).toBe('opens <secret:brace> · agent.act "find the <secret:key>"');
    expect(runs[0]!.e2e).toMatchObject({ test: 'opens <secret:brace>', label: 'find the <secret:key>' });
    const step = steps[0]!;
    const input = JSON.parse(step.input) as {
      prompt: { role: string }[];
      tools: { name: string; parameters: { properties: Record<string, unknown> } }[];
    };
    expect(input.prompt.map((message) => message.role)).toEqual(['system', 'user']);
    // The property name matches the secret and is a key, not a leaf: it stays.
    expect(Object.keys(input.tools[0]!.parameters.properties)).toEqual(['target']);
    const output = JSON.parse(step.output!) as { content: { input: Record<string, unknown> }[] };
    expect(output.content[0]!.input).toEqual({ target: 'n1' });
  });

  it('redactAiTraceDocument applies a later ledger to closed records and keeps the columns parseable', async () => {
    // No redactor: the value was not a secret when the records closed.
    const recorder = new AiTraceRecorder();
    const t = recorder.telemetry;
    const fire = <E>(callback: ((event: E) => unknown) | undefined, event: E) => callback?.(event);
    await withAiTraceScope({ ...SCOPE, test: 'todos › adds hunter2' }, () =>
      withAiTraceStep('agent.act', 'type hunter2', async () => {
        await fire(t.onStart, { callId: 'late', operationId: 'ai.generateText' } as never);
        await fire(t.onStepStart, {
          callId: 'late',
          stepNumber: 0,
          provider: 'gateway',
          modelId: 'm',
          instructions: 'You are a testing agent.',
          messages: [{ role: 'user', content: 'type hunter2 into {' }],
        } as never);
        await fire(t.onStepEnd, {
          callId: 'late',
          stepNumber: 0,
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'type', input: { target: 'n1', text: 'hunter2' } }],
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 20 },
          response: { id: 'r1', modelId: 'm', messages: [] },
        } as never);
        await fire(t.onEnd, { callId: 'late' } as never);
      }),
    );
    const drained = recorder.drain();
    expect(JSON.stringify(drained)).toContain('hunter2');

    const ledger = new SecretLedger([
      ['pw', 'hunter2'],
      ['brace', '{'],
    ]);
    const document = redactAiTraceDocument(drained, ledger.redact);
    expect(JSON.stringify(document)).not.toContain('hunter2');
    expect(document.runs[0]!.function_id).toBe('todos › adds <secret:pw> · agent.act "type <secret:pw>"');
    expect(document.runs[0]!.e2e?.label).toBe('type <secret:pw>');
    const step = document.steps[0]!;
    const input = JSON.parse(step.input) as { prompt: { content: string }[] };
    expect(input.prompt.at(-1)!.content).toBe('type <secret:pw> into <secret:brace>');
    const output = JSON.parse(step.output!) as { content: { input: { target: string; text: string } }[] };
    expect(output.content[0]!.input).toEqual({ target: 'n1', text: '<secret:pw>' });
    // A column with nothing to redact serializes as it did.
    expect(step.usage).toBe(drained.steps[0]!.usage);
    // The drained snapshot is not mutated.
    expect(JSON.stringify(drained)).toContain('hunter2');
  });

  it('closes an open step with the error when the generation fails', async () => {
    const recorder = new AiTraceRecorder();
    await generation(recorder, 'call-1', { fail: true });
    const { steps } = recorder.drain();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.error).toBe('provider exploded');
    expect(steps[0]!.output).toBeNull();
    expect(recorder.pending).toBe(false);
  });

  it('names a run after the scope; outside a scope it keeps the SDK function id', async () => {
    const recorder = new AiTraceRecorder();
    await recorder.telemetry.onStart?.({ callId: 'x', operationId: 'ai.generateText', functionId: 'my-agent' } as never);
    await recorder.telemetry.onEnd?.({ callId: 'x' } as never);
    await withAiTraceScope({ ...SCOPE, attempt: 1 }, () =>
      withAiTraceStep('agent.assert', 'a'.repeat(200), () => generation(recorder, 'y')),
    );
    const names = recorder.drain().runs.map((run) => run.function_id);
    expect(names[0]).toBe('my-agent');
    expect(names[1]).toMatch(/^todos › adds one · attempt 2 · agent\.assert "a{80}…"$/);
  });

  it('continues one run across the generations of a single step, and starts a new run per step', async () => {
    const recorder = new AiTraceRecorder();
    await withAiTraceScope(SCOPE, async () => {
      // A polling judgment: two generations in one step.
      await withAiTraceStep('agent.waitFor', 'users appear', async () => {
        await generation(recorder, 'poll-1');
        await generation(recorder, 'poll-2');
      });
      await withAiTraceStep('agent.assert', 'saved', () => generation(recorder, 'judge'));
    });
    // Outside any step, every generation is its own run.
    await generation(recorder, 'loose-1');
    await generation(recorder, 'loose-2');
    const { runs, steps } = recorder.drain();
    expect(runs.map((run) => run.function_id)).toEqual([
      'todos › adds one · agent.waitFor "users appear"',
      'todos › adds one · agent.assert "saved"',
      null,
      null,
    ]);
    const poll = runs[0]!;
    expect(steps.filter((step) => step.run_id === poll.id).map((step) => step.step_number)).toEqual([1, 2]);
    expect(steps.filter((step) => step.run_id === runs[1]!.id).map((step) => step.step_number)).toEqual([1]);
    expect(steps).toHaveLength(5);
  });

  it('numbers the steps of generations that overlap inside one step without collisions', async () => {
    const recorder = new AiTraceRecorder();
    const t = recorder.telemetry;
    const start = (callId: string) => t.onStart?.({ callId, operationId: 'ai.generateText' } as never);
    const stepStart = (callId: string, stepNumber: number) =>
      t.onStepStart?.({ callId, stepNumber, provider: 'p', modelId: 'm', instructions: 's', messages: [] } as never);
    const stepEnd = (callId: string, stepNumber: number) =>
      t.onStepEnd?.({ callId, stepNumber, content: [], finishReason: 'stop', usage: {}, response: {} } as never);
    await withAiTraceScope(SCOPE, () =>
      withAiTraceStep('agent.act', 'parallel brain', async () => {
        // A custom executor firing two multi-step generations at once.
        await start('a');
        await start('b');
        await stepStart('a', 0);
        await stepStart('b', 0);
        await stepEnd('a', 0);
        await stepStart('a', 1);
        await stepEnd('b', 0);
        await stepStart('b', 1);
        await stepEnd('a', 1);
        await stepEnd('b', 1);
        await t.onEnd?.({ callId: 'a' } as never);
        await t.onEnd?.({ callId: 'b' } as never);
      }),
    );
    const { runs, steps } = recorder.drain();
    expect(runs).toHaveLength(1);
    expect(steps.every((step) => step.run_id === runs[0]!.id)).toBe(true);
    expect(steps.map((step) => step.step_number).toSorted()).toEqual([1, 2, 3, 4]);
  });

  it('attributes a nested generation to the tool that made it, even when tools overlap', async () => {
    const recorder = new AiTraceRecorder();
    const t = recorder.telemetry;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const callId of ['A', 'B']) {
      await t.onStart?.({ callId, operationId: 'ai.generateText' } as never);
      await t.onStepStart?.({
        callId,
        stepNumber: 0,
        provider: 'p',
        modelId: 'm',
        instructions: undefined,
        messages: [],
      } as never);
    }
    // Tool A starts first but its nested generation lands after tool B's.
    await Promise.all([
      t.executeTool!({
        callId: 'A',
        toolCallId: 'ta',
        execute: async () => {
          await delay(15);
          await generation(recorder, 'innerA');
        },
      } as never),
      t.executeTool!({
        callId: 'B',
        toolCallId: 'tb',
        execute: async () => {
          await delay(1);
          await generation(recorder, 'innerB');
        },
      } as never),
    ]);
    const { runs, steps } = recorder.drain({ all: true });
    const [outerA, outerB, innerB, innerA] = runs;
    expect(innerB!.parent_run_id).toBe(outerB!.id);
    expect(innerA!.parent_run_id).toBe(outerA!.id);
    expect(innerA!.parent_step_id).toBe(steps.find((step) => step.run_id === outerA!.id)!.id);
    expect(innerB!.parent_step_id).toBe(steps.find((step) => step.run_id === outerB!.id)!.id);
  });

  it('ignores operations that are not text generations', async () => {
    const recorder = new AiTraceRecorder();
    await recorder.telemetry.onStart?.({ callId: 'e', operationId: 'ai.embed' } as never);
    expect(recorder.drain().runs).toHaveLength(0);
  });

  it('nests a generation made inside a tool under the calling run', async () => {
    const recorder = new AiTraceRecorder();
    const t = recorder.telemetry;
    await t.onStart?.({ callId: 'outer', operationId: 'ai.generateText' } as never);
    await t.onStepStart?.({
      callId: 'outer',
      stepNumber: 0,
      provider: 'p',
      modelId: 'm',
      instructions: undefined,
      messages: [],
    } as never);
    await t.executeTool!({
      callId: 'outer',
      toolCallId: 'tc1',
      execute: () => generation(recorder, 'inner'),
    } as never);
    await t.onEnd?.({ callId: 'outer' } as never);
    const { runs, steps } = recorder.drain({ all: true });
    const outer = runs.find((run) => run.parent_run_id === null)!;
    const inner = runs.find((run) => run.parent_run_id !== null)!;
    expect(inner.parent_run_id).toBe(outer.id);
    expect(inner.parent_step_id).toBe(steps.find((step) => step.run_id === outer.id)!.id);
  });

  it('keeps open steps until they close, and takes them at a final drain', async () => {
    const recorder = new AiTraceRecorder();
    const t = recorder.telemetry;
    await t.onStart?.({ callId: 'c', operationId: 'ai.generateText' } as never);
    await t.onStepStart?.({
      callId: 'c',
      stepNumber: 0,
      provider: 'p',
      modelId: 'm',
      instructions: 'sys',
      messages: [],
    } as never);
    expect(recorder.drain().steps).toHaveLength(0);
    expect(recorder.pending).toBe(true);
    const final = recorder.drain({ all: true });
    expect(final.steps).toHaveLength(1);
    expect(final.steps[0]!.error).toMatch(/run ended/);
    expect(recorder.pending).toBe(false);
  });

  it('records nothing once disposed', async () => {
    const recorder = new AiTraceRecorder();
    recorder.dispose();
    await generation(recorder, 'late');
    expect(recorder.drain({ all: true })).toEqual({ runs: [], steps: [] });
  });

  it('registers through the SDK loader and tolerates a missing SDK', async () => {
    const recorder = new AiTraceRecorder();
    const registered: unknown[] = [];
    await registerAiTraceRecorder(recorder, async () => ({
      registerTelemetry: (...integrations: unknown[]) => registered.push(...integrations),
    }));
    expect(registered).toEqual([recorder.telemetry]);
    await expect(
      registerAiTraceRecorder(recorder, () => Promise.reject(new Error('no ai'))),
    ).resolves.toBeUndefined();
  });
});

describe('AiTraceCollector', () => {
  it('merges snapshots and orders records by start time', () => {
    const collector = new AiTraceCollector();
    const run = (id: string, started_at: string) => ({
      id,
      started_at,
      parent_run_id: null,
      parent_step_id: null,
      function_id: null,
      e2e: undefined,
    });
    const step = (id: string, run_id: string, started_at: string) => ({
      id,
      run_id,
      step_number: 1,
      type: 'generate' as const,
      model_id: 'm',
      provider: null,
      started_at,
      duration_ms: 1,
      input: '{}',
      output: null,
      usage: null,
      error: null,
    });
    collector.merge({ runs: [run('b', '2026-01-01T00:00:02Z')], steps: [step('s2', 'b', '2026-01-01T00:00:02Z')] });
    collector.merge({ runs: [run('a', '2026-01-01T00:00:01Z')], steps: [step('s1', 'a', '2026-01-01T00:00:01Z')] });
    const document = collector.document();
    expect(document.runs.map((r) => r.id)).toEqual(['a', 'b']);
    expect(document.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(collector.size).toBe(2);
  });
});

describe('stringify', () => {
  it('replaces binary payloads with a size note', () => {
    const text = stringify({ data: new Uint8Array(3), nested: [new ArrayBuffer(8)], n: 1n });
    expect(JSON.parse(text)).toEqual({
      data: '[binary 3 bytes omitted]',
      nested: ['[binary 8 bytes omitted]'],
      n: '1',
    });
  });
});
