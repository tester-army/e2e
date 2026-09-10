/**
 * The explorer: the built-in agent (`createAgent`) with exploration guidance
 * appended to the project's and one tool added to the project's vocabulary,
 * `report_finding`. Nothing else changes: budgets, loop guards, wind-down,
 * secrets, origin policy, and the transcript are the harness's, and each
 * exploration step runs as one ordinary `agent.act` step.
 */

import type { ToolExecutionOptions } from 'ai';
import { z } from 'zod';
import { createAgent, type DefaultAgent } from '../agent/default-agent.ts';
import { defineTool, getToolContext, type DefinedTool } from '../agent/tool.ts';
import { asSdkLanguageModel } from '../config/agent.ts';
import type { ModelInstance } from '../types.ts';
import type { ExploreState } from './state.ts';

export const FINDING_TOOL_NAME = 'report_finding';

/** Appended to the project's own guidance; the goal itself travels as agent context. */
export const EXPLORE_RULES = `Exploration mode: this run has no scripted test. Each step is an exploration charter the planner wrote toward the goal given in the project context.
- Think like a curious first-time user hunting for bugs: exercise the flow the charter names end to end, with realistic inputs and edge cases. Interact, do not just look: fill forms with obviously made-up test data and submit them, save and come back to check what was kept, sign in with made-up credentials when none are configured, and when a list has several items act on one that is not the first and check that the right one changed.
- On every screen, sanity-check beyond "it renders": totals equal the sum of their parts and quantities multiply; counts match the items listed; nothing is negative that cannot be; dates are plausible and in order, not an epoch default; copy has no template tokens, placeholders, or misspellings; every control does what its name says; what a screen claims happened (saved, added, removed) is true on the next screen; a password is never shown as you type it.
- Report every defect with ${FINDING_TOOL_NAME} the moment the evidence is on screen, one call per distinct defect: what you expected, what the screen shows, and the actions that reach it. Do not save findings for the conclusion: a defect that appears only in a summary is lost, since the report reads the tool, not the prose. Findings listed under "reportedFindings" in the step parameters are already recorded: never report them again and spend no actions re-confirming them.
- Accounts listed under "credentials" in the step parameters are yours to sign in with: type the username as text and fill the password with type_secret by the account's name. Never type a password as text, and never ask for one. If no type_secret tool is offered, this engine cannot fill a password securely: skip signing in, note it in the step summary, and explore what is reachable without it.
- Report defects, not wishes. A defect is something the screen breaks or contradicts: a wrong value, a dead control, a navigation that lands wrong, a claim that turns out false, leaked template text, a misspelling. A missing feature, a design choice, a form the browser refuses to submit while a required field is empty, or something you merely expected is not a defect unless the screen or the goal promised it. A failed tool call, a refused action, or a limit of this harness is not a product defect either.
- Stay inside the application under test. Do not destroy data that existed before this run (deleting accounts, wiping lists) unless the goal asks for it; creating and editing your own data is fine.
- When the charter is covered, or nothing new is reachable within it, call complete_step. "passed" means you carried the charter out, however many defects you reported on the way: reported findings never make a step fail. "failed" is only for a charter the application would not let you carry out at all: a flow that cannot be completed, a page that cannot be reached. Keep to the charter: a step is one flow, not the whole app. The summary is read by the planner of the next step: say what was covered, what was found, and what looks worth exploring next.`;

export interface ExplorerOptions {
  readonly state: ExploreState;
  /**
   * The project's agent when the config carries one built by `createAgent`:
   * its tools, guidance, model, and provider options are kept. Undefined
   * runs the built-in agent alone.
   */
  readonly base: DefaultAgent | undefined;
  /**
   * The model a replaced hand-rolled executor brought along, so swapping the
   * brain keeps the model the project configured. `base` wins when both exist.
   */
  readonly model?: ModelInstance | undefined;
  /**
   * Writes a finding's evidence pixels and returns the artifact-root-relative
   * path, or undefined when nothing was written. Failures are swallowed: the
   * finding stands without its screenshot.
   */
  readonly evidence: (index: number, pixels: Uint8Array) => Promise<string | undefined>;
}

/** Builds the explorer executor. */
export function createExplorer(options: ExplorerOptions): DefaultAgent {
  const { base } = options;
  const system = [base?.system, EXPLORE_RULES]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n\n');
  const model = base?.model ?? options.model;
  return createAgent({
    ...(model === undefined ? {} : { model: asSdkLanguageModel(model) }),
    system,
    tools: { ...base?.tools, [FINDING_TOOL_NAME]: createFindingTool(options) },
    ...(base?.maxTurns === undefined ? {} : { maxTurns: base.maxTurns }),
    ...(base?.providerOptions === undefined ? {} : { providerOptions: base.providerOptions }),
  });
}

const FINDING_SCHEMA = z.object({
  title: z
    .string()
    .min(4)
    .max(200)
    .describe('A short, specific name for the defect, e.g. "Checkout total shows $0.00 with two items in the cart".'),
  kind: z
    .enum(['issue', 'warning'])
    .describe(
      'issue = a defect a user would hit: a broken flow, wrong data, a dead control, a navigation that lands wrong. warning = cosmetic or polish; blocks no task.',
    ),
  severity: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      '5: a core journey is impossible, data is lost, or money or security is wrong. 4: a core feature is broken but a workaround exists, or wrong money or quantity values are shown. 3: a secondary feature is broken, or wrong non-monetary content. 2: a cosmetic or layout defect that blocks nothing. 1: a trivial polish item (usually a warning).',
    ),
  expected: z.string().min(1).max(2000).describe('What a user would expect here.'),
  actual: z.string().min(1).max(2000).describe('What the screen shows instead, quoted from the observation.'),
  reproduction: z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(20)
    .describe('The actions that reach the defect from the start of the app, one per entry.'),
});

type FindingReport = z.output<typeof FINDING_SCHEMA>;

/**
 * The finding tool. Read-only: it observes the screen for the location and
 * the evidence pixels, records the finding against the step in progress, and
 * answers the model with the finding's number so it is not reported twice.
 */
export function createFindingTool(options: ExplorerOptions): DefinedTool {
  return defineTool(
    {
      description:
        'Report one product defect you have evidence of on the current screen: what you expected, what the screen shows, and how to reach it. Call it the moment the evidence is visible, once per distinct defect. Not for tool errors or refused actions.',
      inputSchema: FINDING_SCHEMA,
      execute: async (input: FindingReport, executionOptions: ToolExecutionOptions<unknown>) => {
        const { observe } = getToolContext(executionOptions);
        const observation = await observe({ pixels: true }).catch(() => undefined);
        const finding = options.state.addFinding({
          title: input.title,
          kind: input.kind,
          severity: input.severity as 1 | 2 | 3 | 4 | 5,
          expected: input.expected,
          actual: input.actual,
          reproduction: input.reproduction,
          ...(observation?.path === undefined ? {} : { path: observation.path }),
          ...(observation === undefined ? {} : { observationRevision: observation.revision }),
        });
        const pixels = observation?.pixels;
        if (pixels !== undefined) {
          const screenshot = await options.evidence(finding.index, pixels.data).catch(() => undefined);
          if (screenshot !== undefined) options.state.attachEvidence(finding.id, screenshot);
        }
        return `Finding ${finding.index + 1} recorded (${finding.kind}, severity ${finding.severity}): ${finding.title}. Do not report it again; continue the charter or conclude the step.`;
      },
    },
    { mutates: false },
  );
}
