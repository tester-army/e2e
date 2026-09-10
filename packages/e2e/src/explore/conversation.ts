/**
 * The conversation arm of the context benchmark: the whole exploration as one
 * `agent.act()` step whose executor is the tool-loop chassis with the grammar,
 * `report_finding`, and three orchestration tools (`start_step`,
 * `finish_step`, `finish_run`), TesterArmy's shape. One long history instead
 * of one act per charter with a ledger handoff. Product behavior is the
 * step-per-charter body in `body.ts`; this exists to be measured against it.
 */

import { z } from 'zod';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import type { DefaultAgent } from '../agent/default-agent.ts';
import { AgentError, isAgentError } from '../agent/error.ts';
import type { StepExecutor, StepExecutorContext } from '../agent/executor.ts';
import { createGrammarTools } from '../agent/primitives.ts';
import { compactScreenHistory, ScreenPresenter } from '../agent/screen-update.ts';
import { withToolContext } from '../agent/tool.ts';
import { createToolLoopExecutor } from '../agent/tool-loop.ts';
import { asSdkLanguageModel } from '../config/agent.ts';
import { credentials } from '../credentials.ts';
import type { ModelInstance, TestFn } from '../types.ts';
import { createFindingTool, EXPLORE_RULES, FINDING_TOOL_NAME, type ExplorerOptions } from './executor.ts';
import type { ExploreState } from './state.ts';

/** The whole exploration is one step, so it gets the largest budgets the config admits. */
export const CONVERSATION_STEP_BUDGET = 100;

const CONVERSATION_RULES = `You are an autonomous exploratory testing agent. This whole run is one conversation: you decide what to test, one focused step at a time.
- The screen is a tree of nodes with stable ids like "n42"; every action result reports what changed. Never invent ids.
- Open each step with start_step (a short title and what you will do), do the work with the action tools, then close it with finish_step: "passed" when you carried it out, "failed" when the application would not let you. Keep steps focused: one flow or screen, five to fifteen actions; if a step balloons, close it and open the next.
- Prefer breadth: touch the main flows the goal names before drilling deeper. Do not re-test what a passed step covered unless a finding points back at it. Chase anomalies: when something looks off, spend the next step confirming it.
- When the goal is covered, or nothing new is reachable, call finish_run with your overall assessment, then complete_step with status "passed". Findings you reported never make the run fail here; the runner judges them.

${EXPLORE_RULES}`;

const presenters = new WeakMap<StepExecutorContext, ScreenPresenter>();
function presenterFor(context: StepExecutorContext): ScreenPresenter {
  let presenter = presenters.get(context);
  if (presenter === undefined) {
    presenter = new ScreenPresenter();
    presenters.set(context, presenter);
  }
  return presenter;
}

export interface ConversationOptions extends ExplorerOptions {
  readonly base: DefaultAgent | undefined;
  readonly model?: ModelInstance | undefined;
}

/** Builds the one-conversation explorer. */
export function createConversationExplorer(options: ConversationOptions): StepExecutor {
  const { state, base } = options;
  const model = base?.model ?? options.model;
  const finding = createFindingTool(options);
  return createToolLoopExecutor({
    name: 'e2e-explore-conversation',
    version: '1',
    ...(model === undefined ? {} : { model: asSdkLanguageModel(model) }),
    system: [base?.system, CONVERSATION_RULES].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n'),
    ...(base?.providerOptions === undefined ? {} : { providerOptions: base.providerOptions }),
    prepareMessages: compactScreenHistory,
    tools: (context, helpers): ToolSet => ({
      ...createGrammarTools(context, { guard: helpers.guard, screen: presenterFor(context) }),
      // The finding tool is a project-style tool: it runs under the step's accounting with the observation context.
      [FINDING_TOOL_NAME]: {
        ...finding.tool,
        execute: (input: never, executionOptions: ToolExecutionOptions<unknown>) =>
          helpers.guard(() =>
            context.budgets.runTool({ name: FINDING_TOOL_NAME, mutates: false }, async () =>
              String(await finding.tool.execute!(input, withToolContext(executionOptions, { observe: (observeOptions) => context.observe(observeOptions) }))),
            ),
          ),
      } as ToolSet[string],
      start_step: {
        description: 'Open the next exploration step: a short title and what you will do in it. Close the previous step first.',
        inputSchema: z.object({ title: z.string().min(4).max(200), instruction: z.string().min(10).max(2000) }),
        execute: async ({ title, instruction }: { title: string; instruction: string }) => {
          if (state.steps.length >= state.budgets.maxSteps) return 'The step limit is reached: call finish_run with your assessment, then complete_step.';
          try {
            const index = state.beginStep(title, instruction);
            return `Step ${index} of ${state.budgets.maxSteps} open: ${title}.`;
          } catch (cause) {
            return `Close the current step with finish_step first (${cause instanceof Error ? cause.message : String(cause)}).`;
          }
        },
      } as ToolSet[string],
      finish_step: {
        description: 'Close the open exploration step with its outcome and a one-to-three sentence summary of what was covered and found.',
        inputSchema: z.object({ status: z.enum(['passed', 'failed']), summary: z.string().min(1).max(2000) }),
        execute: async ({ status, summary }: { status: 'passed' | 'failed'; summary: string }) => {
          try {
            const step = state.endStep(status, summary);
            return `Step ${step.index} closed as ${status}. ${state.steps.length} of ${state.budgets.maxSteps} steps used; ${state.findings.length} finding(s) so far.`;
          } catch (cause) {
            return `No step is open (${cause instanceof Error ? cause.message : String(cause)}); call start_step first.`;
          }
        },
      } as ToolSet[string],
      finish_run: {
        description: 'End the exploration with your overall assessment: what was explored, the key findings, your verdict on the goal. Then call complete_step with status "passed".',
        inputSchema: z.object({ summary: z.string().min(10).max(4000) }),
        execute: async ({ summary }: { summary: string }) => {
          state.summary = summary;
          state.ended = 'finished';
          return 'Assessment recorded. Call complete_step with status "passed" to end the run.';
        },
      } as ToolSet[string],
    }),
    buildPrompt: async (context) => {
      const observation = await context.observe();
      const parts = [`Explore toward this goal: ${context.step.instruction}`];
      if (context.step.params !== undefined) parts.push(`Step parameters:\n${JSON.stringify(context.step.params)}`);
      parts.push(`Budget: ${state.budgets.maxSteps} steps, ${CONVERSATION_STEP_BUDGET} model turns. Open the first step with start_step.`);
      parts.push(presenterFor(context).initial(observation));
      return parts.join('\n\n');
    },
  });
}

export interface ConversationBodyOptions {
  readonly state: ExploreState;
  readonly openApp: boolean;
  readonly credentials?: readonly string[] | undefined;
}

/** The test body for the conversation arm: one act, then the same verdict as the step-per-charter body. */
export function createConversationBody(options: ConversationBodyOptions): TestFn {
  const { state } = options;
  return async ({ agent, app }) => {
    if (options.openApp) await app.open();
    const accounts = (options.credentials ?? []).map((name) => ({ name, username: credentials.user(name).username, password: credentials.user(name).password }));
    const params =
      accounts.length === 0
        ? undefined
        : { credentials: Object.fromEntries(accounts.map((account) => [account.name, { username: account.username, password: account.password }])) };
    try {
      await agent.act(state.goal, {
        timeout: state.budgets.timeoutMs,
        maxSteps: CONVERSATION_STEP_BUDGET,
        maxModelCalls: CONVERSATION_STEP_BUDGET,
        ...(params === undefined ? {} : { params }),
      });
    } catch (cause) {
      if (!isAgentError(cause) || cause.code === 'CANCELLED') throw cause;
      // Out of turns or time mid-conversation: the record so far stands.
      if (state.ended !== 'finished') state.ended = cause.code === 'STEP_TIMEOUT' ? 'time' : 'step-limit';
    }
    if (state.currentStepOpen()) state.endStep('exhausted', 'the conversation ended with this step open');
    if (state.ended === 'aborted') state.ended = 'step-limit';
    conclude(state);
  };
}

function conclude(state: ExploreState): void {
  if (state.steps.length === 0 && state.findings.length === 0) {
    throw new AgentError('AUTOMATION_UNSUPPORTED', 'exploration concluded nothing: no step ran and no finding was recorded', { blocked: true });
  }
  const issues = state.issues;
  if (issues.length > 0) {
    throw new AgentError('ASSERTION_FAILED', `exploration found ${issues.length} issue(s): ${issues.map((finding) => `[severity ${finding.severity}] ${finding.title}`).join('; ')}`);
  }
}
