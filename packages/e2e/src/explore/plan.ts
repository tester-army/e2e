/**
 * The planner: between exploration steps, one structured model call decides
 * the next charter or finishes the run. It runs as an `agent.extract` step,
 * so it reads the current screen and the ledger of prior steps the same way
 * every judgment does, under the same budgets and repair loop.
 */

import { z } from 'zod';
import type { Agent } from '../types.ts';
import { MAX_INSTRUCTION_CHARS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS, type ExploreState } from './state.ts';

const MIN_SUMMARY_CHARS = 10;
/** A title derived from an instruction stops at the first clause or here. */
const DERIVED_TITLE_CHARS = 80;

/**
 * A flat object with optional fields rather than a union: every provider
 * renders it, and the refinement below turns a missing field into a repair
 * round that names it. The shape is lenient on purpose: a model that puts the
 * whole charter into `title` and leaves `instruction` empty (seen live) has
 * still planned a step, and `planNext` derives the missing field rather than
 * spending the repair round on it.
 */
export const PLAN_SCHEMA = z
  .object({
    decision: z.enum(['step', 'finish']),
    title: z.string().max(MAX_INSTRUCTION_CHARS).optional(),
    instruction: z.string().max(MAX_INSTRUCTION_CHARS).optional(),
    summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === 'step') {
      if (`${value.title ?? ''}${value.instruction ?? ''}`.trim() === '') {
        context.addIssue({ code: 'custom', path: ['instruction'], message: 'a step needs a concrete instruction' });
      }
    } else if ((value.summary ?? '').trim().length < MIN_SUMMARY_CHARS) {
      context.addIssue({ code: 'custom', path: ['summary'], message: 'finishing needs an overall assessment' });
    }
  });

export type PlanDecision =
  | { readonly kind: 'step'; readonly title: string; readonly instruction: string }
  | { readonly kind: 'finish'; readonly summary: string };

/** One configured credential the explorer can sign in with, by name; the password stays out of every prompt. */
export interface PlanAccount {
  readonly name: string;
  readonly username: string;
}

export interface PlanRequest {
  /** The run must end now; the planner is asked for the closing assessment only. */
  readonly mustFinish: boolean;
  /** The accounts the explorer can sign in with. */
  readonly accounts?: readonly PlanAccount[] | undefined;
  /** Why it must end, in the planner's prompt. */
  readonly reason?: string | undefined;
  readonly remainingMs: number;
  readonly timeoutMs: number;
}

/** Asks the model for the next charter or the closing assessment. */
export async function planNext(agent: Agent, state: ExploreState, request: PlanRequest): Promise<PlanDecision> {
  const plan = await agent.extract(planInstruction(state, request), {
    schema: PLAN_SCHEMA,
    timeout: request.timeoutMs,
  });
  if (plan.decision === 'finish') return { kind: 'finish', summary: plan.summary!.trim() };
  return normalizeStep(plan.title, plan.instruction);
}

/**
 * The step's title and instruction, each derived from the other when the
 * model filled only one: a charter with no title takes its first clause, a
 * title with no charter is the charter.
 */
export function normalizeStep(title: string | undefined, instruction: string | undefined): PlanDecision {
  const givenTitle = (title ?? '').trim();
  const givenInstruction = (instruction ?? '').trim();
  const charter = givenInstruction === '' ? givenTitle : givenInstruction;
  // A title that stood in for the charter is a heading only while it is short.
  const longest = givenInstruction === '' ? DERIVED_TITLE_CHARS : MAX_TITLE_CHARS;
  const heading = givenTitle !== '' && givenTitle.length <= longest ? givenTitle : deriveTitle(charter);
  return { kind: 'step', title: heading, instruction: charter };
}

function deriveTitle(charter: string): string {
  const clause = charter.split(/[.:;\n]/, 1)[0]!.trim();
  const short = clause === '' ? charter : clause;
  return short.length <= DERIVED_TITLE_CHARS ? short : `${short.slice(0, DERIVED_TITLE_CHARS - 1)}…`;
}

const STATUS_MARKS: Record<ExploreState['steps'][number]['status'], string> = {
  passed: 'passed',
  failed: 'FAILED',
  blocked: 'blocked',
  exhausted: 'ended at its limit',
};

/** The planner's instruction: the goal, the record so far, the budget, and how to decide. */
export function planInstruction(state: ExploreState, request: PlanRequest): string {
  const used = state.steps.length;
  const minutesLeft = Math.max(0, Math.round(request.remainingMs / 60_000));
  const steps =
    used === 0
      ? '(none yet: this is the first step)'
      : state.steps
          .map((step) => `${step.index}. [${STATUS_MARKS[step.status]}] ${step.title}${step.summary === undefined ? '' : ` — ${step.summary}`}`)
          .join('\n');
  const findings =
    state.findings.length === 0
      ? '(none yet)'
      : state.findings.map((finding) => `- [${finding.kind}, severity ${finding.severity}] ${finding.title}`).join('\n');
  const header = [
    request.mustFinish
      ? 'Finish an exploratory test run with your overall assessment.'
      : 'Plan the next step of an exploratory test run, or finish it.',
    '',
    `Goal: ${state.goal}`,
    `Budget: ${used} of ${state.budgets.maxSteps} steps used, about ${minutesLeft} minute(s) left.`,
    '',
    'Steps so far:',
    steps,
    '',
    'Findings so far:',
    findings,
    ...(request.accounts === undefined || request.accounts.length === 0
      ? []
      : [
          '',
          'Accounts the agent can sign in with (it fills the password itself, by name):',
          ...request.accounts.map((account) => `- ${account.name} (username: ${account.username})`),
        ]),
    '',
  ];
  if (request.mustFinish) {
    return [
      ...header,
      `The run must end now: ${request.reason ?? 'its budget is spent'}.`,
      'Respond with {"decision": "finish", "summary": "..."}: the overall assessment in two to five sentences,',
      'what was explored, the key findings, and your verdict on the goal. Ground it in the steps and findings above.',
    ].join('\n');
  }
  return [
    ...header,
    'Decide from the goal, the steps so far, and the current screen:',
    '- "step": the next exploration charter. "title" names the area or flow in a few words. "instruction" is a concrete,',
    '  self-contained charter for an agent that sees only the screen and that text: which flow to exercise, what inputs',
    '  to try, what to check. One flow or screen per step, sized for five to fifteen actions; split anything bigger.',
    '  Ask the agent to interact, not only to look: submit forms with made-up test data, save and revisit, sign in with',
    '  the accounts listed above (or made-up credentials when none are configured), act on a non-first item of a list. Prefer breadth: touch the main',
    '  flows the goal names before drilling deeper into one. Do not re-test an area a passed step already covered, and',
    '  never plan a step to re-confirm a finding already recorded above. When a step ended at its limit, continue where',
    '  it stopped or move on. When a step summary mentions something odd that is not among the findings, spend the next',
    '  step confirming it.',
    '- "finish": the goal is covered, or nothing new is reachable. "summary" is the overall assessment in two to',
    '  five sentences: what was explored, the key findings, and your verdict on the goal.',
    'Respond with {"decision": "step", "title": "...", "instruction": "..."} or {"decision": "finish", "summary": "..."}.',
  ].join('\n');
}
