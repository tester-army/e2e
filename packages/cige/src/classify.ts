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

import type { Report } from 'e2e';

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

/** Codes that mean execution never fairly reached the system under test. */
const INFRASTRUCTURE_CODES = new Set([
  'AUTH_CREDENTIAL_UNAVAILABLE',
  'AUTH_CREDENTIAL_INVALID',
  'SECRET_UNAVAILABLE',
  'ENVIRONMENT_UNAVAILABLE',
  'APP_UNREACHABLE',
  'APP_ALREADY_RUNNING',
  'APP_NOT_OPEN',
  'SEED_DATA_MISSING',
  'TEST_SETUP_FAILED',
  'MODEL_UNAVAILABLE',
  'MODEL_PROVIDER_FAILED',
]);

/** Codes an `act` step ends with when its path no longer leads where it used to. */
const PATH_CODES = new Set(['ACTION_FAILED', 'LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS', 'REPLAY_STALE']);

/**
 * Codes that say the agent ran out of room, not that the path is stale: a
 * spent budget, the clock, a verb the engine lacks, a model that never
 * concluded. A changed flow can cause them, and so can a slow environment
 * or a weak model, so they leave the type to the classifier.
 */
const AUTOMATION_CODES = new Set(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'AUTOMATION_UNSUPPORTED', 'STEP_NO_CONCLUSION', 'CONTEXT_OVERFLOW']);

interface PlannedStep {
  readonly phase: CigePhase;
  readonly id: string;
  readonly api: 'agent.act' | 'agent.assert';
  readonly label: string;
}

/** The agent steps the case makes, in the order `runCige` makes them. */
function plan(testCase: CigeCase): PlannedStep[] {
  const steps: PlannedStep[] = testCase.execution.map((step) =>
    step.kind === 'act'
      ? { phase: 'execution', id: step.id, api: 'agent.act', label: actInstruction(testCase, step) }
      : { phase: 'execution', id: step.id, api: 'agent.assert', label: step.text },
  );
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

function locate(testCase: CigeCase, attempt: AttemptView): { phase: CigePhase; id?: string; code?: string; message?: string } {
  const planned = plan(testCase);
  const pairs = match(attempt, planned);
  const failing = pairs.find((pair) => pair.step.status !== 'passed');
  if (failing !== undefined) {
    const error = failing.step.error ?? attempt.error;
    return {
      phase: failing.planned.phase,
      id: failing.planned.id,
      ...(error === undefined ? {} : { code: error.code, message: error.message }),
    };
  }
  const error = attempt.error;
  const located = error === undefined ? {} : { code: error.code, message: error.message };
  const evidence = /CIGE evidence ([A-Za-z0-9][A-Za-z0-9._-]*) (?:not satisfied|could not be checked)/.exec(error?.message ?? '')?.[1];
  if (evidence !== undefined) return { phase: 'evidence', id: evidence, ...located };
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
  const failureType = ((): CigeFailureType | undefined => {
    if (where.phase === 'precondition' || INFRASTRUCTURE_CODES.has(code)) return 'infrastructure';
    if (where.phase === 'execution' && PATH_CODES.has(code)) return 'outdated-test-logic';
    if (code === 'ASSERTION_FAILED') return 'product-defect';
    return undefined;
  })();
  if (code === 'ASSERTION_INCONCLUSIVE') signals.push('inconclusive-evidence');
  if (AUTOMATION_CODES.has(code)) signals.push('automation-limit');
  if (result.status === 'timed-out') signals.push('run-stopped');
  return { ...base, ...(failureType === undefined ? {} : { failureType }), signals };
}
