/**
 * Dogfood: a fully hand-rolled StepExecutor whose tools have nothing to do
 * with the engine — the "agent-device pattern". The config sets no
 * `agent.model`; the executor brings its own transport. Tests never open the
 * app, so the engine surface is never touched.
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/e2e/dist/cli/bin.js run --config e2e.dogfood-brain.config.ts
 */

import type { E2EConfig, StepExecutor, StepVerdict } from 'e2e';
import { web } from '@e2edev/web';
import { createGateway, stepCountIs, tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';

const MODEL_ID = process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna-fast';

const mathBrain: StepExecutor = {
  name: 'math-brain',
  version: '1',
  async runStep(context) {
    const model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(MODEL_ID);
    let verdict: StepVerdict | undefined;
    const compute = (name: string, body: () => number) =>
      context.budgets.runTool({ name, mutates: false }, async () => String(body()));
    const loop = new ToolLoopAgent({
      model,
      instructions:
        'You are a calculator agent. Your ONLY capabilities are the add and multiply tools. ' +
        'Work the step with them, then call conclude exactly once. If the step needs anything ' +
        'beyond arithmetic, conclude with status "failed" and say plainly what you cannot do.',
      tools: {
        add: tool({
          description: 'Add two numbers.',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => compute('add', () => a + b),
        }),
        multiply: tool({
          description: 'Multiply two numbers.',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => compute('multiply', () => a * b),
        }),
        conclude: tool({
          description: 'Conclude the step with the final verdict.',
          inputSchema: z.object({
            status: z.enum(['passed', 'failed']),
            summary: z.string().max(400),
          }),
          execute: async (input) => {
            verdict ??= input;
            return 'Concluded.';
          },
        }),
      },
      toolChoice: 'required',
      stopWhen: [() => verdict !== undefined, stepCountIs(8)],
    });
    await loop.generate({
      prompt: `Step: ${context.step.instruction}`,
      abortSignal: context.signal,
      onStepEnd: ({ usage }) =>
        context.budgets.recordModelCall({
          ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          provider: 'gateway',
          modelId: MODEL_ID,
        }),
    });
    return (
      verdict ?? {
        status: 'failed',
        summary: 'the math brain never concluded',
        errorCode: 'STEP_NO_CONCLUSION',
      }
    );
  },
};

export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-dogfood-brain',
  tests: 'tests-dogfood-brain/**/*.e2e.ts',
  targets: [{ name: 'web', engine: web({ url: 'http://127.0.0.1:4312' }) }],
  timeout: 120_000,
  agents: { default: mathBrain },
} satisfies E2EConfig;
