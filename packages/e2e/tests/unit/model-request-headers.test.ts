import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModelAdapter } from '../../src/agent/model/sdk.ts';
import { defineTool } from '../../src/agent/tool.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { USER_AGENT } from '../../src/internal/client-identity.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** Headers of every request the endpoint received, oldest first. */
const received: IncomingHttpHeaders[] = [];
let server: Server;
let baseURL: string;

/** Loop requests answered so far; the first calls `peek`, the rest conclude. */
let loopTurns = 0;

/** A chat completion that answers the judgment call with JSON and the act loop with `peek`, then a passing verdict. */
function completion(body: { tools?: unknown[] }) {
  let message: object = { role: 'assistant', content: '{"ok":true}' };
  if (body.tools !== undefined) {
    loopTurns += 1;
    const call = loopTurns === 1
      ? { name: 'peek', arguments: '{}' }
      : { name: 'complete_step', arguments: '{"status":"passed","summary":"done"}' };
    message = { role: 'assistant', content: null, tool_calls: [{ id: `call_${loopTurns}`, type: 'function', function: call }] };
  }
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, message, finish_reason: body.tools === undefined ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      received.push(request.headers);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(completion(JSON.parse(raw) as { tools?: unknown[] })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  received.length = 0;
  loopTurns = 0;
});

/** A read-only project tool, so the first turn does not conclude the step. */
const peek = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });

function chatModel() {
  return createOpenAICompatible({ name: 'scripted', baseURL }).chatModel('scripted');
}

function expectIdentified(headers: IncomingHttpHeaders | undefined) {
  expect(headers?.['user-agent']?.startsWith(`${USER_AGENT} `)).toBe(true);
  expect(headers?.['user-agent']).toContain(' ai/');
  expect(headers?.['http-referer']).toBe('https://tester.army/e2e');
  expect(headers?.['x-title']).toBe('e2e');
}

describe('model request headers', () => {
  it('identifies e2e on a judgment call, ahead of the AI SDK user agent', async () => {
    const model = chatModel();
    const adapter = createModelAdapter({ provider: model.provider, id: model.modelId, model });

    await adapter.generate({
      system: 's',
      prompt: 'p',
      schemaName: 'judgment',
      schema: undefined,
      validate: (value: unknown) => ({ ok: true as const, value }),
      maxOutputTokens: 16,
      maxInputTokens: 64_000,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(received).toHaveLength(1);
    expectIdentified(received[0]);
  });

  it('identifies e2e on every turn of an act loop', async () => {
    const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
    const config = resolveConfig(
      { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', agents: { default: { model: chatModel(), tools: { peek } } } },
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
      attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
      artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
      priorSteps: () => steps.completed(),
      agentContext: undefined,
      saveSession: undefined,
      models: new WorkerModels(() => {}),
    });

    await fixtures.agent.act('look around');

    expect(steps.all()[0]?.status).toBe('passed');
    expect(received).toHaveLength(2);
    for (const headers of received) expectIdentified(headers);
  });
});
