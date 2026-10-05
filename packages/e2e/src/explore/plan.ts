/**
 * The planner: between exploration steps, one structured model call decides
 * the next charter or finishes the run. It runs as an `agent.extract` step,
 * so it reads the current screen and the ledger of prior steps the same way
 * every judgment does, under the same budgets and repair loop.
 */

import { z } from 'zod';
import type { ReportExploreStep } from '../report/build.ts';
import type { Agent } from '../types.ts';
import { MAX_TITLE_CHARS, type ExploreState } from './state.ts';

const MIN_SUMMARY_CHARS = 10;
/** A title derived from an instruction stops at the first clause or here. */
const DERIVED_TITLE_CHARS = 80;
/**
 * The most the grammar accepts in one field. Well above the report's ceilings,
 * which the state clips to when the step opens: a model that pours a whole
 * charter into one field (seen live, past 2000 characters) has still planned
 * a step, and a rejection would cost a repair round for nothing. Validation
 * enforces it, not the provider: `extract` sends a schema's shape without
 * its value rules, so a runaway field runs to the judgment's output ceiling
 * and costs the repair round; when the repair runs away too, the planner
 * falls back to its built-in charter.
 */
const MAX_FIELD_CHARS = 8_000;

/**
 * A flat object with every field required rather than a union: OpenAI's
 * strict structured output rejects a schema whose `required` omits a
 * property, and every provider renders a flat object. Fields the decision
 * does not use are empty strings. The shape is lenient on purpose: a model
 * that puts the whole charter into `title` and leaves `instruction` empty
 * (seen live) has still planned a step, and `repairPlan` derives the missing
 * field rather than spending the repair round on it.
 */
export const PLAN_SCHEMA = z
  .object({
    decision: z.enum(['step', 'finish']),
    title: z.string().max(MAX_FIELD_CHARS).describe('For a step: the area or flow as a heading of two to five words, e.g. "Cart quantities". Empty for finish.'),
    instruction: z.string().max(MAX_FIELD_CHARS).describe('For a step: the concrete charter. Empty for finish.'),
    summary: z.string().max(MAX_FIELD_CHARS).describe('For finish: the overall assessment. Empty for a step.'),
  })
  .superRefine((value, context) => {
    if (value.decision === 'step') {
      if (`${value.title}${value.instruction}`.trim() === '') {
        context.addIssue({ code: 'custom', path: ['instruction'], message: 'a step needs a concrete instruction' });
      }
    } else if (value.summary.trim().length < MIN_SUMMARY_CHARS) {
      context.addIssue({ code: 'custom', path: ['summary'], message: 'finishing needs an overall assessment' });
    }
  });

type PlanAnswer = z.output<typeof PLAN_SCHEMA>;

export type PlanDecision =
  | { readonly kind: 'step'; readonly title: string; readonly instruction: string }
  | { readonly kind: 'finish'; readonly summary: string };

/** One configured credential the explorer can sign in with, by name; the password stays out of every prompt. */
export interface PlanAccount {
  readonly name: string;
  readonly username: string;
}

/**
 * What the planner and the explorer are told when the exploration starts
 * from a saved session, so neither spends a step signing in again or signs
 * the rest of the run out.
 */
export function signedInContext(session: string): string {
  return `The app starts signed in: the run restored the session "${session}" a setup test saved. Do not sign in again, and do not sign out, unless the goal asks for it.`;
}

export interface PlanRequest {
  /** The run must end now; the planner is asked for the closing assessment only. */
  readonly mustFinish: boolean;
  /** The accounts the explorer can sign in with. */
  readonly accounts?: readonly PlanAccount[] | undefined;
  /** The saved session the exploration started from, when it started signed in. */
  readonly session?: string | undefined;
  /** Why it must end, in the planner's prompt. */
  readonly reason?: string | undefined;
  readonly remainingMs: number;
  readonly timeoutMs: number;
}

/** Asks the model for the next charter or the closing assessment. */
export async function planNext(agent: Agent, state: ExploreState, request: PlanRequest): Promise<PlanDecision> {
  return repairPlan(
    await agent.extract(planInstruction(state, request), {
      schema: PLAN_SCHEMA,
      timeout: request.timeoutMs,
      allowUnobserved: true,
    }),
  );
}

/**
 * The decision, after the repairs live providers' answers have needed. Every
 * repair the planner makes is here:
 *
 * - Digit runs a provider pads a field with (seen live: a title followed by
 *   hundreds of `1234567890`) are removed; they carry no meaning and would
 *   otherwise become the charter's tail. The threshold sits past any number a
 *   charter can mean: phone numbers, order ids, card numbers, and amounts all
 *   stop short of twenty digits.
 * - A step with only one of `title` and `instruction` filled has the other
 *   derived: a charter with no title takes its first clause, a title with no
 *   charter is the charter.
 *
 * Length is not repaired here: the grammar accepts long fields, and the state
 * clips them to the report's ceilings when the step opens.
 */
export function repairPlan(answer: PlanAnswer): PlanDecision {
  if (answer.decision === 'finish') return { kind: 'finish', summary: unpad(answer.summary) };
  const title = unpad(answer.title);
  const instruction = unpad(answer.instruction);
  const charter = instruction === '' ? title : instruction;
  // A title that stood in for the charter is a heading only while it is short.
  const longest = instruction === '' ? DERIVED_TITLE_CHARS : MAX_TITLE_CHARS;
  const heading = title !== '' && title.length <= longest ? title : deriveTitle(charter);
  return { kind: 'step', title: heading, instruction: charter };
}

function unpad(text: string): string {
  return text.replace(/\s*\d{20,}\s*/g, ' ').trim();
}

function deriveTitle(charter: string): string {
  const clause = charter.split(/[.:;\n]/, 1)[0]!.trim();
  const short = clause === '' ? charter : clause;
  return short.length <= DERIVED_TITLE_CHARS ? short : `${short.slice(0, DERIVED_TITLE_CHARS - 1)}…`;
}

/**
 * What the closing assessment is for. The findings and the steps print above
 * it, so it carries what neither list can: the verdict, the gaps, and what
 * to script next.
 */
const ASSESSMENT_RULES = [
  'The assessment is two to four plain sentences for the person reading the terminal, where the steps and the findings',
  'are already listed above it. Do not list or count the findings again. Say: your verdict on the goal in one sentence;',
  'what the goal names that was not reached or not fully exercised, and why; and which one or two flows are most worth',
  'turning into scripted tests. Name screens and controls as the app names them; no headings, bullets, or markdown.',
];

const STATUS_MARKS: Record<ReportExploreStep['status'], string> = {
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
    ...(request.session === undefined ? [] : ['', signedInContext(request.session)]),
    ...(request.accounts === undefined || request.accounts.length === 0
      ? []
      : [
          '',
          'Accounts the agent can sign in with (it fills the password itself, by name):',
          ...request.accounts.map((account) => `- ${account.name} (username: ${account.username})`),
        ]),
    '',
  ];
  const signIn =
    request.session === undefined
      ? 'sign in with the accounts listed above (or made-up credentials when none are configured)'
      : 'work as the signed-in user rather than signing in again';
  if (request.mustFinish) {
    return [
      ...header,
      `The run must end now: ${request.reason ?? 'its budget is spent'}.`,
      'Respond with {"decision": "finish", "title": "", "instruction": "", "summary": "..."}: the closing assessment.',
      ...ASSESSMENT_RULES,
    ].join('\n');
  }
  return [
    ...header,
    'Decide from the goal, the steps so far, and the current screen:',
    '- "step": the next exploration charter. "title" names the area or flow in a few words. "instruction" is a concrete,',
    '  self-contained charter for an agent that sees only the screen and that text: which flow to exercise, what inputs',
    '  to try, what to check. One flow or screen per step, sized for five to fifteen actions; split anything bigger.',
    '  Ask the agent to interact, not only to look: submit forms with made-up test data, save and revisit,',
    `  ${signIn}, act on a non-first item of a list. Prefer breadth: touch the main`,
    '  flows the goal names before drilling deeper into one. Do not re-test an area a passed step already covered, and',
    '  never plan a step to re-confirm a finding already recorded above. When a step ended at its limit, continue where',
    '  it stopped or move on. When a step summary mentions something odd that is not among the findings, spend the next',
    '  step confirming it.',
    '- "finish": the goal is covered, or nothing new is reachable. "summary" is the closing assessment.',
    ...ASSESSMENT_RULES.map((line) => `  ${line}`),
    'Respond with every field present: {"decision": "step", "title": "...", "instruction": "...", "summary": ""} or {"decision": "finish", "title": "", "instruction": "", "summary": "..."}.',
  ].join('\n');
}
