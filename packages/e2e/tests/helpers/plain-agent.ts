/**
 * The plainest executor the chassis can carry, for the integration tests that
 * need an `agent.act()` brain and nothing more: the grammar toolset over
 * `ctx.actions`, every mutating tool returning the whole fresh tree, one
 * action per turn. It is deliberately naive — the runner ships no agent, and
 * this one exists to exercise the harness, not to be good at testing.
 */

import { tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { createToolLoopExecutor, type ToolLoopHelpers } from '../../src/agent/tool-loop.ts';

export interface PlainAgentOptions {
  readonly model?: Exclude<LanguageModel, string>;
  readonly system?: string;
  readonly maxTurns?: number;
}

export function plainAgent(options: PlainAgentOptions = {}): StepExecutor {
  return createToolLoopExecutor({
    name: 'plain-test-agent',
    version: '1',
    ...(options.model === undefined ? {} : { model: options.model }),
    system: [
      'You are a test agent executing exactly one step. Use the tools; node ids like "n42" come from the newest screen. Issue one mutating action per turn.',
      options.system,
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n'),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    tools: (context, helpers) => grammarTools(context, helpers),
    buildPrompt: async (context) => {
      const observation = await context.observe();
      return [
        `Execute this test step: ${context.step.instruction}`,
        ...(context.step.params === undefined ? [] : [`Step parameters:\n${JSON.stringify(context.step.params, null, 2)}`]),
        ...(context.ledger === '' ? [] : [`Previously completed steps:\n${context.ledger}`]),
        `Screen (revision ${observation.revision}):\n${observation.text}`,
      ].join('\n\n');
    },
  });
}

function grammarTools(context: StepExecutorContext, helpers: ToolLoopHelpers): ToolSet {
  const target = z.string().min(1);
  const strip = (id: string): string => id.replace(/^#/, '');
  const acted = async (done: string): Promise<string> => {
    const observation = await context.observe();
    return `${done}\n\nUpdated screen (revision ${observation.revision}):\n${observation.text}`;
  };
  const tools: ToolSet = {
    observe: tool({
      description: 'Capture the current screen.',
      inputSchema: z.object({}),
      execute: () => helpers.guard(async () => acted('Observed.')),
    }),
    tap: tool({
      description: 'Tap one node.',
      inputSchema: z.object({ target }),
      execute: ({ target: id }) =>
        helpers.guard(async () => {
          await context.actions.tap({ id: strip(id) });
          return acted(`Tapped #${strip(id)}.`);
        }),
    }),
    type: tool({
      description: 'Type into one node.',
      inputSchema: z.object({ target, value: z.string() }),
      execute: ({ target: id, value }) =>
        helpers.guard(async () => {
          await context.actions.type({ id: strip(id) }, value);
          return acted(`Typed into #${strip(id)}.`);
        }),
    }),
    press: tool({
      description: 'Press one key on one node.',
      inputSchema: z.object({ target, key: z.string() }),
      execute: ({ target: id, key }) =>
        helpers.guard(async () => {
          await context.actions.press({ id: strip(id) }, key);
          return acted(`Pressed ${key}.`);
        }),
    }),
    select: tool({
      description: 'Select one option by label.',
      inputSchema: z.object({ target, value: z.string() }),
      execute: ({ target: id, value }) =>
        helpers.guard(async () => {
          await context.actions.select({ id: strip(id) }, value);
          return acted(`Selected ${value}.`);
        }),
    }),
    scroll: tool({
      description: 'Scroll the viewport.',
      inputSchema: z.object({ direction: z.enum(['up', 'down', 'left', 'right']) }),
      execute: ({ direction }) =>
        helpers.guard(async () => {
          await context.actions.scroll(direction);
          return acted(`Scrolled ${direction}.`);
        }),
    }),
    navigate: tool({
      description: 'Navigate to a URL or path.',
      inputSchema: z.object({ url: z.string() }),
      execute: ({ url }) =>
        helpers.guard(async () => {
          await context.actions.navigate(url);
          return acted(`Navigated to ${url}.`);
        }),
    }),
  };
  if (context.step.secrets.length > 0) {
    tools['type_secret'] = tool({
      description: `Fill a declared secret. Available: ${context.step.secrets.map((secret) => secret.name).join(', ')}.`,
      inputSchema: z.object({ target, name: z.string() }),
      execute: ({ target: id, name }) =>
        helpers.guard(async () => {
          await context.actions.typeSecret({ id: strip(id) }, name);
          return acted(`Filled secret "${name}".`);
        }),
    });
  }
  return tools;
}
