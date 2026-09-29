/**
 * The explorer: the built-in agent with exploration guidance appended to the
 * project's and one tool added to the project's vocabulary,
 * `report_finding`. Nothing else changes: budgets, loop guards, wind-down,
 * secrets, origin policy, and the transcript are the harness's, and each
 * exploration step runs as one ordinary `agent.act` step.
 */

import type { ToolExecutionOptions } from 'ai';
import { z } from 'zod';
import type { ResolvedAgentConfig } from '../config/agent.ts';
import { defineTool, getToolContext, type DefinedTool } from '../agent/tool.ts';
import type { AgentConfig } from '../types.ts';
import type { ExploreState } from './state.ts';

export const FINDING_TOOL_NAME = 'report_finding';

/** Appended to the project's own guidance; the goal itself travels as agent context. */
const EXPLORE_RULES = `Exploration mode: this run has no scripted test. Each step is an exploration charter the planner wrote toward the goal given in the project context.
- Think like a curious first-time user hunting for bugs: exercise the flow the charter names end to end, with realistic inputs and edge cases. Interact, do not just look: fill forms with obviously made-up test data and submit them, save and come back to check what was kept, sign in with made-up credentials when none are configured, and when a list has several items act on one that is not the first and check that the right one changed.
- On every screen, sanity-check beyond "it renders": totals equal the sum of their parts and quantities multiply; counts match the items listed; nothing is negative that cannot be; dates are plausible and in order, not an epoch default; copy has no template tokens, placeholders, or misspellings; every control does what its name says; what a screen claims happened (saved, added, removed) is true on the next screen; a password is never shown as you type it.
- Report every defect with ${FINDING_TOOL_NAME} the moment the evidence is on screen, one call per distinct defect: what you expected, what the screen shows, and the actions that reach it. Do not save findings for the conclusion: a defect that appears only in a summary is lost, since the report reads the tool, not the prose. Findings listed under "reportedFindings" in the step parameters are already recorded: never report them again and spend no actions re-confirming them.
- Accounts listed under "credentials" in the step parameters are yours to sign in with: type the username as text and fill the password with type_secret by the account's name. Never type a password as text, and never ask for one. If no type_secret tool is offered, this engine cannot fill a password securely: skip signing in, note it in the step summary, and explore what is reachable without it.
- Report defects, not wishes. A defect is something the screen breaks or contradicts: a wrong value, a dead control, a navigation that lands wrong, a claim that turns out false, leaked template text, a misspelling. A missing feature, a design choice, a form the browser refuses to submit while a required field is empty, or something you merely expected is not a defect unless the screen or the goal promised it. A failed tool call, a refused action, or a limit of this harness is not a product defect either.
- Stay inside the application under test. Do not destroy data that existed before this run (deleting accounts, wiping lists) unless the goal asks for it; creating and editing your own data is fine.
- When the charter is covered, or nothing new is reachable within it, call complete_step. "passed" means you carried the charter out, however many defects you reported on the way: reported findings never make a step fail. "failed" is only for a charter the application would not let you carry out at all: a flow that cannot be completed, a page that cannot be reached. Keep to the charter: a step is one flow, not the whole app. The summary is read by the planner of the next step: say what was covered, what was found, and what looks worth exploring next.`;

export interface ExplorerOptions {
  readonly state: ExploreState;
  /** The key of the agents entry the exploration runs as, which a notice names. */
  readonly agentName: string;
  /** The agents entry the exploration runs as, as configured; undefined is the built-in agent with no options. */
  readonly entry: AgentConfig | undefined;
  /** The same entry resolved, whose models a replaced custom executor's own ones are read from. */
  readonly resolved: ResolvedAgentConfig;
  /** Told when a custom executor is replaced. */
  readonly notice: (message: string) => void;
}

/**
 * The agents entry the exploration runs as: the project's own options, its
 * guidance and tools included, with the exploration rules added. A custom
 * executor has no readable vocabulary and is replaced, with a notice,
 * keeping the models it brought. The finding tool joins once the entry is
 * resolved (`withFindingTool`): its name is reserved, so a project tool can
 * never take it.
 */
export function explorerAgent(options: ExplorerOptions): AgentConfig {
  const entry: AgentConfig = options.entry ?? {};
  const { executor, system, tools, ...shared } = entry;
  let models: Pick<AgentConfig, 'model' | 'judge'> = {};
  if (executor !== undefined) {
    const { model, judge } = options.resolved;
    options.notice(
      `agents.${options.agentName} is a custom executor ("${executor.name}"); explore runs the built-in agent instead` +
        (executor.model === undefined ? '' : ', with the model that executor brought'),
    );
    models = {
      ...(model === undefined ? {} : { model: model.model }),
      ...(judge === undefined ? {} : { judge: judge.model }),
    };
  }
  return {
    ...shared,
    ...models,
    system: [system, EXPLORE_RULES].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n'),
    ...(tools === undefined ? {} : { tools }),
  };
}

/** The resolved explorer with the finding tool beside the project's tools. */
export function withFindingTool(explorer: ResolvedAgentConfig, state: ExploreState): ResolvedAgentConfig {
  return { ...explorer, tools: { ...explorer.tools, [FINDING_TOOL_NAME]: createFindingTool(state) } };
}

const FINDING_SCHEMA = z.object({
  title: z
    .string()
    .min(4)
    .max(200)
    .describe('A specific headline for the defect under 80 characters, e.g. "Checkout total shows $0.00 with two items in the cart".'),
  kind: z
    .enum(['issue', 'warning'])
    .describe(
      'issue = a defect a user would hit: a broken flow, wrong data, a dead control, a navigation that lands wrong. warning = cosmetic or polish; blocks no task.',
    ),
  severity: z
    .literal([1, 2, 3, 4, 5])
    .describe(
      '5: a core journey is impossible, data is lost, or money or security is wrong. 4: a core feature is broken but a workaround exists, or wrong money or quantity values are shown. 3: a secondary feature is broken, or wrong non-monetary content. 2: a cosmetic or layout defect that blocks nothing. 1: a trivial polish item (usually a warning).',
    ),
  expected: z.string().min(1).max(2000).describe('What a user would expect here, in one sentence.'),
  actual: z.string().min(1).max(2000).describe('What the screen shows instead, in one sentence, quoting the text on screen.'),
  reproduction: z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(20)
    .describe('The actions that reach the defect from the start of the app, one short imperative per entry, e.g. "Open the cart".'),
});

type FindingReport = z.output<typeof FINDING_SCHEMA>;

/**
 * The finding tool. Read-only: it observes the screen for the location and
 * the evidence pixels, records the finding against the step in progress,
 * keeps the pixels as a screenshot artifact of the step, and answers the
 * model with the finding's number so it is not reported twice.
 */
function createFindingTool(state: ExploreState): DefinedTool {
  // Numbered as the calls arrive, before any await: a model may report two
  // findings in one turn, and read-only tools run in parallel, so the
  // finding's own index is not known until its screenshot is saved.
  let reported = 0;
  return defineTool(
    {
      description:
        'Report one product defect you have evidence of on the current screen: what you expected, what the screen shows, and how to reach it. Call it the moment the evidence is visible, once per distinct defect. Not for tool errors or refused actions.',
      inputSchema: FINDING_SCHEMA,
      execute: async (input: FindingReport, executionOptions: ToolExecutionOptions<unknown>) => {
        const { observe, attachScreenshot } = getToolContext(executionOptions);
        reported += 1;
        const label = `finding-${reported}`;
        const observation = await observe({ pixels: true }).catch(() => undefined);
        // Evidence is worth keeping, never worth failing the finding for. It
        // is saved first, so the finding is announced complete, evidence included.
        const artifactId =
          observation?.pixels === undefined
            ? undefined
            : await attachScreenshot(observation.pixels, label).catch(() => undefined);
        const finding = state.addFinding({ ...input, path: observation?.path, observationRevision: observation?.revision, artifactId });
        return `Finding ${finding.index + 1} recorded (${finding.kind}, severity ${finding.severity}): ${finding.title}. Do not report it again; continue the charter or conclude the step.`;
      },
    },
    { mutates: false },
  );
}
