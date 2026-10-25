/**
 * A first, deterministic classification of one CIGE result from what the
 * report records: the result status, the error code, and which part of the
 * case the failure landed in. It is a hint for the classifying agent, never
 * the verdict: every summary says `confidence: "heuristic"`, names the raw
 * signals it read, and leaves `failureType` out whenever the code alone
 * cannot tell the cases apart (a guardrail violation, an inconclusive
 * judgment). The `cige` skill's classify step confirms it against `specRef`,
 * `buildRef`, and `expectedRef` before any repair, and decides whether a
 * pass was a false positive; this module never calls one.
 */

import type { AgentError, Report } from 'e2e';

import { violatedGuardrail } from './guardrails.ts';
import { actInstruction, intentAssertion } from './render.ts';
import type { CigeCase } from './schema.ts';

type ReportResult = Report['run']['results'][number];
type ReportAttempt = ReportResult['attempts'][number];
type ReportStep = ReportAttempt['steps'][number];
type ReportSerialGroup = Report['run']['serialGroups'][number];

/** What classification reads of one attempt: a test's own, or its member's share of a serial group's. */
export interface AttemptView {
  readonly steps: readonly ReportStep[];
  readonly error?: ReportAttempt['error'];
  readonly artifacts: ReportAttempt['artifacts'];
}

/**
 * The attempts of a result, oldest first. A member of a serial group keeps
 * none of its own (`result.attempts` is empty): its steps live on the
 * group's attempts, under its `testId`.
 */
export function attemptsOf(result: ReportResult, report?: Report): readonly AttemptView[] {
  if (result.serialGroupId === undefined) return result.attempts;
  const groups: readonly ReportSerialGroup[] = [...(report?.run.serialGroups ?? []), ...(report?.run.carried?.serialGroups ?? [])];
  const group = groups.find((candidate) => candidate.id === result.serialGroupId);
  if (group === undefined) return result.attempts;
  return group.attempts.map((attempt) => {
    const member = attempt.members.find((candidate) => candidate.testId === result.testId);
    const error = member?.error ?? attempt.error;
    return { steps: member?.steps ?? [], ...(error === undefined ? {} : { error }), artifacts: attempt.artifacts };
  });
}

/**
 * The failure types a run summary can carry. The standard's fourth route, a
 * false positive, is a pass that should not have counted; only the
 * classifying agent can call one, from the `screen-only-evidence` signal and
 * the evidence, so it is never set here.
 */
export type CigeFailureType = 'infrastructure' | 'outdated-test-logic' | 'product-defect';

/** Where in the case a failure landed. */
export type CigePhase = 'precondition' | 'execution' | 'evidence' | 'intent';

export interface CigeClassification {
  readonly result: 'pass' | 'fail' | 'skipped' | 'interrupted';
  /** The Execution step, evidence item, or `intent` the failure landed in. */
  readonly failedStep?: string;
  readonly phase?: CigePhase;
  /** Absent on a pass, and whenever the signals don't decide it. */
  readonly failureType?: CigeFailureType;
  readonly errorCode?: string;
  readonly message?: string;
  /** What the classification read, e.g. `code:REPLAY_STALE`, `guardrail-violation:g2`, `screen-only-evidence`. */
  readonly signals: readonly string[];
}

/** The runner's closed agent code union, typed so a code renamed in core fails to compile here. */
type AgentErrorCode = AgentError['code'];

/**
 * The error classes the runner assigns (`error.category` in the report)
 * that mean execution never fairly reached the system under test: the
 * environment, the app, a credential, seed data, the model provider. A new
 * code of these classes in core needs no change here.
 */
const SETUP_CATEGORIES: ReadonlySet<string> = new Set(['infrastructure', 'configuration']);

/**
 * `configuration`-class codes that are not the environment: `POLICY_DENIED`
 * is the runner refusing what a step asked for (a denied navigation, a
 * forbidden fill; a guardrail's is read earlier), and `REPLAY_STALE` is a
 * stale recorded path. Outside an act step they stay untyped.
 */
const NOT_SETUP_CODES: ReadonlySet<string> = new Set<AgentErrorCode>(['POLICY_DENIED', 'REPLAY_STALE']);

/**
 * The one `test`-class code the runner blocks a step with that is a setup gap,
 * not an automation limit: the report carries no blocked category, so it is
 * named.
 */
const BLOCKED_SETUP_CODE: AgentErrorCode = 'APP_NOT_OPEN';

/**
 * `test`-class codes no category tells apart, so they are named: the codes
 * an `act` step ends with when its path no longer leads where it used to.
 * `REPLAY_STALE` is a `configuration` code but a stale recorded path, so
 * these are read before the category.
 */
const PATH_CODES: ReadonlySet<string> = new Set<AgentErrorCode>(['ACTION_FAILED', 'LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS', 'REPLAY_STALE']);

/**
 * `test`-class codes for a spent budget, the clock, or a model that never
 * concluded: a changed flow, a slow environment, or a weak model can each
 * cause them, so they leave the type to the classifier. Anything the runner
 * reports as a blocked step (an unsupported verb, an overflowing context, a
 * refusal) joins them without being named.
 */
const STEP_LIMIT_CODES: ReadonlySet<string> = new Set<AgentErrorCode>(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'STEP_NO_CONCLUSION']);

interface PlannedStep {
  readonly phase: CigePhase;
  readonly id: string;
  readonly api: 'agent.act' | 'agent.assert';
  readonly label: string;
}

/** The agent steps the case makes, in the order `runCige` makes them. */
function plan(testCase: CigeCase): PlannedStep[] {
  // A plugin's `use` step makes no agent step, so there is nothing of it to pair.
  const steps: PlannedStep[] = testCase.execution.flatMap((step): PlannedStep[] => {
    if (step.kind === 'act') return [{ phase: 'execution', id: step.id, api: 'agent.act', label: actInstruction(testCase, step) }];
    if (step.kind === 'verify') return [{ phase: 'execution', id: step.id, api: 'agent.assert', label: step.text }];
    return [];
  });
  for (const item of testCase.intent.evidence) {
    if (item.kind === 'assert') steps.push({ phase: 'evidence', id: item.id, api: 'agent.assert', label: item.text });
  }
  if (testCase.intent.judge) steps.push({ phase: 'intent', id: 'intent', api: 'agent.assert', label: intentAssertion(testCase) });
  return steps;
}

function sameLabel(reported: string, planned: string): boolean {
  if (reported === planned) return true;
  // A report may clip a long label; compare what both still hold.
  const length = Math.min(reported.length, planned.length, 256);
  return length > 0 && reported.slice(0, length) === planned.slice(0, length);
}

/** Pairs each body agent step of the attempt with the planned step it ran, in order. */
function match(attempt: AttemptView, planned: readonly PlannedStep[]): { step: ReportStep; planned: PlannedStep }[] {
  const pairs: { step: ReportStep; planned: PlannedStep }[] = [];
  let next = 0;
  for (const step of attempt.steps) {
    if (step.kind !== 'agent' || step.phase !== undefined) continue;
    const index = planned.findIndex((candidate, at) => at >= next && candidate.api === step.api && sameLabel(step.label, candidate.label));
    if (index === -1) continue;
    pairs.push({ step, planned: planned[index]! });
    next = index + 1;
  }
  return pairs;
}

interface Located {
  readonly phase: CigePhase;
  readonly id?: string;
  readonly code?: string;
  readonly message?: string;
  /** The runner's class for the error: `test`, `configuration`, `infrastructure`, `internal`, or `interrupted`. */
  readonly category?: string;
  /** The failing agent step ended `blocked`: something stood in its way, not a product failure. */
  readonly blocked?: boolean;
  readonly pluginStep?: boolean;
}

function locate(testCase: CigeCase, attempt: AttemptView): Located {
  const planned = plan(testCase);
  const pairs = match(attempt, planned);
  const failing = pairs.find((pair) => pair.step.status !== 'passed');
  if (failing !== undefined) {
    const error = failing.step.error ?? attempt.error;
    return {
      phase: failing.planned.phase,
      id: failing.planned.id,
      ...(error === undefined ? {} : { code: error.code, message: error.message, category: error.category }),
      ...(failing.step.status === 'blocked' ? { blocked: true } : {}),
    };
  }
  const error = attempt.error;
  const located = error === undefined ? {} : { code: error.code, message: error.message, category: error.category };
  const evidence = /CIGE evidence ([A-Za-z0-9][A-Za-z0-9._-]*) (?:not satisfied|could not be checked)/.exec(error?.message ?? '')?.[1];
  if (evidence !== undefined) return { phase: 'evidence', id: evidence, ...located };
  const used = /CIGE step ([A-Za-z0-9][A-Za-z0-9._-]*) \(/.exec(error?.message ?? '')?.[1];
  if (used !== undefined) return { phase: 'execution', id: used, pluginStep: true, ...located };
  if (/CIGE (precondition|hook)/.test(error?.message ?? '') || error?.phase === 'beforeEach' || error?.phase === 'beforeAll') {
    return { phase: 'precondition', ...located };
  }
  const ran = new Set(pairs.map((pair) => pair.planned.id));
  const unfinished = testCase.execution.find((step) => !ran.has(step.id));
  if (unfinished !== undefined) {
    // Nothing of the case ran: the failure came before the first step.
    if (pairs.length === 0 && unfinished === testCase.execution[0]) return { phase: 'precondition', ...located };
    return { phase: 'execution', id: unfinished.id, ...located };
  }
  return { phase: 'evidence', ...located };
}

/**
 * Classifies one report result of a CIGE case. Pass the report it came from
 * when the result may be a serial group's member, whose attempts live there.
 */
export function classifyResult(testCase: CigeCase, result: ReportResult, report?: Report): CigeClassification {
  if (result.status === 'skipped') return { result: 'skipped', signals: ['status:skipped'] };
  // Stopped before a verdict: core never counts it as failed, so neither does a summary.
  if (result.status === 'interrupted') return { result: 'interrupted', signals: ['status:interrupted'] };
  const attempt = attemptsOf(result, report).at(-1);
  if (result.status === 'passed' || result.status === 'flaky') {
    const signals: string[] = [`status:${result.status}`];
    if (!testCase.intent.evidence.some((item) => item.kind === 'hook')) signals.push('screen-only-evidence');
    return { result: 'pass', signals };
  }
  if (attempt === undefined) return { result: 'fail', signals: [`status:${result.status}`, 'no-attempt'] };

  const where = locate(testCase, attempt);
  const signals: string[] = [`status:${result.status}`, `phase:${where.phase}`];
  if (where.code !== undefined) signals.push(`code:${where.code}`);
  const base = {
    result: 'fail' as const,
    phase: where.phase,
    ...(where.id === undefined ? {} : { failedStep: where.id }),
    ...(where.code === undefined ? {} : { errorCode: where.code }),
    ...(where.message === undefined ? {} : { message: where.message }),
  };

  const guardrail = violatedGuardrail(where.message);
  if (guardrail !== undefined) {
    // The agent took a forbidden path: a changed flow that now routes
    // through it, or a product that forces it. Only the spec can tell.
    return { ...base, signals: [...signals, `guardrail-violation:${guardrail}`] };
  }
  const code = where.code ?? '';
  // The agent read a guardrail and stopped before acting: the step needs a
  // forbidden action, which routes like a violation. Only a conclusion that
  // cites a guardrail counts; the runner's own POLICY_DENIED (a refused URL
  // scheme, a forbidden fill) is something else.
  const message = where.message ?? '';
  if (code === 'POLICY_DENIED' && where.phase === 'execution' && /guardrail/i.test(message)) {
    const cited = testCase.guardrails.find((rule) => new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExp(rule.id)}($|[^A-Za-z0-9._-])`).test(message));
    return { ...base, signals: [...signals, cited === undefined ? 'guardrail-refused' : `guardrail-refused:${cited.id}`] };
  }
  if (where.pluginStep === true) {
    // A plugin's step threw a plain error: its own code, not a changed flow, so the classifier reads its message.
    return { ...base, signals: [...signals, `plugin-step-failed:${where.id}`] };
  }
  // ASSERTION_FAILED is a defect when a check said so: a verify, evidence, the
  // Intent, or a plugin's step. From an act step it means the agent couldn't
  // reach the goal, which a changed flow causes as often as a defect.
  const step = where.phase === 'execution' ? testCase.execution.find((entry) => entry.id === where.id) : undefined;
  const unreachedGoal = code === 'ASSERTION_FAILED' && step?.kind === 'act';
  if (unreachedGoal) signals.push('goal-unreachable');
  const failureType = ((): CigeFailureType | undefined => {
    if (where.phase === 'precondition') return 'infrastructure';
    if (where.phase === 'execution' && PATH_CODES.has(code)) return 'outdated-test-logic';
    if (where.category !== undefined && SETUP_CATEGORIES.has(where.category) && !NOT_SETUP_CODES.has(code)) return 'infrastructure';
    if (code === 'ASSERTION_FAILED' && !unreachedGoal) return 'product-defect';
    return undefined;
  })();
  if (code === 'ASSERTION_INCONCLUSIVE') signals.push('inconclusive-evidence');
  if (STEP_LIMIT_CODES.has(code) || (where.blocked === true && where.category === 'test' && code !== BLOCKED_SETUP_CODE)) signals.push('automation-limit');
  if (result.status === 'timed-out') signals.push('run-stopped');
  return { ...base, ...(failureType === undefined ? {} : { failureType }), signals };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
