/**
 * The tools a session offers: the built-in agent's action tools
 * (`createGrammarTools` from `e2e/agent`) and its `complete_step`
 * (`createVerdictTool`). An ACP session lists its tools once, while e2e
 * builds them per step, so the session lists them from its first step and
 * each call runs the active step's own tool of that name. Every action goes
 * through `ctx.actions`, where the runner authorizes, counts, and records
 * it, so steps replay from the cache as the built-in agent's do.
 */

import type { StepExecutorContext, StepVerdict } from 'e2e';
import { createGrammarTools, createVerdictTool, isRuntimeHardStop, type ScreenOutput, type VerdictTool } from 'e2e/agent';
import type { z } from 'zod';
import type { ServedTool, ToolResult } from './mcp.ts';

/** Tools that change nothing in the app, so an assertion may use them. */
const READ_ONLY = new Set(['observe', 'screenshot', 'scroll', 'scroll_to', 'hover', 'hover_at']);

/** One tool as `e2e/agent` builds it: an AI SDK tool. */
interface AgentTool {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly execute?: (input: unknown, options: { toolCallId: string; messages: [] }) => unknown;
}
type AgentTools = Readonly<Record<string, AgentTool>>;

/** The step a session serves now. */
export interface ActiveStep {
  readonly ctx: StepExecutorContext;
  /** The step's `complete_step`, which holds its verdict once the agent concludes. */
  readonly conclusion: VerdictTool;
  /** A runtime error a tool hit; the turn is cancelled and `runStep` rethrows it. */
  halted: unknown;
  /** A tool of the agent's own that ran without asking; the turn is cancelled and the step fails. */
  denied: string | undefined;
  /** Tool names in call order, for the transcript. */
  readonly calls: string[];
  /** The step's own action tools, built on its first look. */
  tools?: AgentTools;
}

/** The step a session starts serving, with nothing concluded yet. */
export function activeStep(ctx: StepExecutorContext): ActiveStep {
  return { ctx, conclusion: createVerdictTool(), halted: undefined, denied: undefined, calls: [] };
}

/** The verdict the agent concluded the step with, if it did. */
export function verdictOf(active: ActiveStep): StepVerdict | undefined {
  return active.conclusion.verdict();
}

/** Where the tools find the active step, and how a tool ends the turn early. */
export interface StepSlot {
  active: ActiveStep | undefined;
  /** Called when a tool hit a runtime error: cancels the agent's turn. */
  halt(): void;
}

/** The active step's action tools, built once per step so its screens report changes against the one before. */
function toolsOf(active: ActiveStep): AgentTools {
  active.tools ??= createGrammarTools(active.ctx) as AgentTools;
  return active.tools;
}

/** Runs one tool and returns what it answered. */
async function run(tools: AgentTools, name: string, input: unknown): Promise<ScreenOutput> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(unavailable(name));
  return (await tool.execute(input, { toolCallId: name, messages: [] })) as ScreenOutput;
}

/** The step's first screen, whole: the first look of its action tools, which later results report changes against. */
export async function openingScreen(active: ActiveStep): Promise<string> {
  const output = await run(toolsOf(active), 'observe', {});
  return typeof output === 'string' ? output : output.text;
}

/** The listed tools the active step does not offer, by the reason it would give. */
export function missingTools(active: ActiveStep, listed: readonly ServedTool[]): string[] {
  const own = toolsOf(active);
  return listed.filter((tool) => tool.name !== 'complete_step' && own[tool.name] === undefined).map((tool) => `${tool.name} (${unavailable(tool.name)})`);
}

/** The session's tools, listed from its first step. */
export function stepTools(slot: StepSlot, first: StepExecutorContext): ServedTool[] {
  const current = (name: string): ActiveStep => {
    const active = slot.active;
    if (active === undefined || active.conclusion.concluded() || active.halted !== undefined || active.denied !== undefined) {
      throw new Error('No step is active. Wait for the next instruction.');
    }
    active.calls.push(name);
    return active;
  };
  /** Runs a tool body against the active step; a runtime error ends the turn, anything else goes back to the agent as the call's error. */
  const guarded = async (name: string, body: (active: ActiveStep) => Promise<ToolResult>): Promise<ToolResult> => {
    let active: ActiveStep | undefined;
    try {
      active = current(name);
      return await body(active);
    } catch (error) {
      if (active !== undefined && isRuntimeHardStop(error)) {
        active.halted = error;
        slot.halt();
        return { text: `The step has ended (${error.code}). Stop and wait for the next instruction.`, isError: true };
      }
      return { text: `${name} failed: ${firstLine(error)}`, isError: true };
    }
  };
  const tools: ServedTool[] = [];
  for (const [name, tool] of Object.entries(listing(first))) {
    const readOnly = READ_ONLY.has(name);
    tools.push({
      name,
      description: name === 'type_secret' ? TYPE_SECRET : (tool.description ?? name),
      inputSchema: tool.inputSchema as z.ZodObject,
      readOnly,
      run: (args) =>
        guarded(name, async (active) => {
          if (!readOnly && active.ctx.step.kind === 'assert') {
            throw new Error('this step is an assertion: read the screen and conclude, do not change it');
          }
          return result(await run(toolsOf(active), name, args));
        }),
    });
  }
  const conclusion = createVerdictTool().tool as AgentTool;
  tools.push({
    name: 'complete_step',
    description: conclusion.description ?? 'complete_step',
    inputSchema: conclusion.inputSchema as z.ZodObject,
    readOnly: true,
    run: (args) =>
      guarded('complete_step', async (active) => {
        const answer = await run({ complete_step: active.conclusion.tool as AgentTool }, 'complete_step', args);
        const text = typeof answer === 'string' ? answer : answer.text;
        return { text: active.conclusion.concluded() ? `${text} Wait for the next instruction.` : text };
      }),
  });
  return tools;
}

/** Listed in place of the grammar's own description, which names one step's secrets. */
const TYPE_SECRET =
  'Fill one declared secret into an input by its name; the plaintext never passes through you. A password fills only a password field; a generic-secret fills any editable input. The step message lists the secrets it declares.';

/**
 * Every action tool any step of the attempt can get: the first step's, with
 * the two that come and go per step added. `type_secret` is built only for a
 * step that declares secrets, and `screenshot` goes once a secret was filled;
 * a call of either where the active step has none says why.
 */
function listing(first: StepExecutorContext): AgentTools {
  const widest = Object.create(first, {
    pixelsTainted: { value: false },
    step: { value: { ...first.step, secrets: [{ name: 'secret', purpose: 'password' }] } },
  }) as StepExecutorContext;
  return createGrammarTools(widest) as AgentTools;
}

function unavailable(name: string): string {
  if (name === 'type_secret') return 'this step declares no secrets';
  if (name === 'screenshot') return 'a secret was filled in this attempt, so no screenshots leave the runner until it ends (PIXEL_TAINTED)';
  return `${name} is not available in this step`;
}

/** A rendered screen as an MCP result: its text, and the screenshot as an image when it carries one. */
function result(output: ScreenOutput): ToolResult {
  if (typeof output === 'string') return { text: output };
  return { text: output.text, image: { data: Buffer.from(output.pixels.data).toString('base64'), mimeType: output.pixels.mediaType } };
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}
