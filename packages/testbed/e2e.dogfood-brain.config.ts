/**
 * Dogfood: a fully hand-rolled StepExecutor whose tools have nothing to do
 * with the backend — the "agent-device pattern". The config sets no
 * `agent.model`; the executor brings its own transport. Tests never open the
 * app, so the backend surface is never touched.
 *
 *   AI_GATEWAY_API_KEY=... node node_modules/@e2edev/e2e/dist/cli/bin.js run --config e2e.dogfood-brain.config.ts
 */

import { defineConfig, type StepExecutor, type StepVerdict } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';
import { createGateway, stepCountIs, tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';

const mathBrain: StepExecutor = {
  name: 'math-brain',
  version: '1',
  async runStep(context) {
    const model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'google/gemini-3-flash',
    );
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
          modelId: process.env.E2E_MODEL ?? 'google/gemini-3-flash',
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

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-dogfood-brain',
  app: { url: 'http://127.0.0.1:4312' },
  tests: 'tests-dogfood-brain/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
  timeout: 120_000,
  agent: mathBrain,
});
