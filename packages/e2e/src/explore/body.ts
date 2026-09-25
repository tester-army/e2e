/**
 * The exploration body: the test `e2e explore` registers in memory. A loop
 * of ordinary `agent.act` steps, one per charter the planner writes, under
 * the exploration's own budgets. The outcome policy is the one TesterArmy's
 * discovery runs settled on: a step that ends at its budget is a time-boxed
 * charter and not a failure; a failed step is a finding and the run goes on;
 * three failed or blocked steps in a row, the step cap, or the clock end the
 * run with a closing assessment; findings of kind `issue` fail the run; a run
 * that explored nothing and found nothing, or whose charters were all blocked,
 * stays blocked.
 */

import { AgentError, isAgentError } from '../agent/error.ts';
import { BLOCKABLE_CODES } from '../agent/executor.ts';
import { credentials } from '../secrets.ts';
import type { ReportExplore, ReportExploreStep } from '../report/build.ts';
import type { Agent, AgentErrorCode, AgentParams, TestFn } from '../types.ts';
import { planNext, type PlanAccount, type PlanDecision } from './plan.ts';
import type { ExploreState } from './state.ts';

/** Failed or blocked steps in a row, none with a finding, that end the run: the approach is not working. */
export const CONSECUTIVE_FAILURE_LIMIT = 3;
/** Time kept back for the closing assessment once no step can start. */
const FINISH_RESERVE_MS = 60_000;
/** The least time a step is worth starting with. */
const MIN_STEP_MS = 45_000;
/** The planner's deadline: one structured call plus a repair round, on a slow provider. */
const PLAN_TIMEOUT_MS = 90_000;
/** Below this, not even the closing assessment is asked for. */
const MIN_PLAN_TIMEOUT_MS = 30_000;

export interface ExploreBodyOptions {
  readonly state: ExploreState;
  /** Each step's own deadline, before the run's remaining time caps it. */
  readonly stepTimeoutMs: number;
  /**
   * Whether to open the app first. `app.open()` needs a target with a declared
   * URL; a device target without one is explored where the last test, or the
   * run's warm-up, left the app.
   */
  readonly openApp: boolean;
  /**
   * The configured accounts. Each travels with every charter as a step
   * secret, so the explorer can sign in with `type_secret` by name; the
   * password itself never reaches the model.
   */
  readonly accounts?: readonly PlanAccount[] | undefined;
  readonly now?: (() => number) | undefined;
}

/** Why the loop stopped, with the closing assessment when the planner gave one. */
interface Ending {
  readonly ended: ReportExplore['ended'];
  readonly summary?: string | undefined;
}

/** What the loop runs with. */
interface Loop {
  readonly agent: Agent;
  readonly state: ExploreState;
  readonly accounts: readonly PlanAccount[];
  /** The accounts with their passwords as secrets, once resolved; undefined when none is configured. */
  readonly secrets: AgentParams | undefined;
  readonly stepTimeoutMs: number;
  readonly remaining: () => number;
}

/** Builds the test body for one exploration. */
export function createExploreBody(options: ExploreBodyOptions): TestFn {
  const { state } = options;
  const now = options.now ?? Date.now;
  const accounts = options.accounts ?? [];
  return async ({ agent, app }) => {
    const deadline = now() + state.budgets.timeoutMs;
    state.start();
    if (options.openApp) await app.open();
    // Resolved here, once the runner has the credential registry up.
    const secrets =
      accounts.length === 0
        ? undefined
        : Object.fromEntries(
            accounts.map((account) => [account.name, { username: account.username, password: credentials.user(account.name).password }]),
          );
    const ending = await runSteps({ agent, state, accounts, secrets, stepTimeoutMs: options.stepTimeoutMs, remaining: () => deadline - now() });
    state.end(ending.ended, ending.summary);
    conclude(state);
  };
}

/**
 * Plan, act, repeat, until something ends the run; returns why. A cancelled
 * step or a failing provider throws out instead, and the record keeps its
 * `aborted` default.
 */
async function runSteps(loop: Loop): Promise<Ending> {
  const { agent, state, remaining } = loop;
  /** Planner answers outside the grammar in a row; one is covered, two end the run. */
  let plannerFailures = 0;
  for (;;) {
    const stop = mustFinish(state, remaining());
    if (stop !== undefined && remaining() < MIN_PLAN_TIMEOUT_MS) return { ended: stop.ended };
    let plan: PlanDecision;
    state.planning(stop !== undefined);
    try {
      plan = await planNext(agent, state, {
        mustFinish: stop !== undefined,
        reason: stop?.reason,
        accounts: loop.accounts,
        remainingMs: remaining(),
        timeoutMs: Math.max(MIN_PLAN_TIMEOUT_MS, Math.min(PLAN_TIMEOUT_MS, remaining())),
      });
      plannerFailures = 0;
    } catch (cause) {
      // A model that cannot produce a plan in the grammar, even after the
      // repair round, is a model shortcoming, not the end of the world: one
      // failure is covered by a built-in charter (a survey first, a
      // continuation later); two in a row end the exploration with the
      // record so far; a failed closing assessment leaves the run to end for
      // the reason it had to, without one. Anything else (the provider, the
      // clock, a cancellation) is the run's error.
      if (!isAgentError(cause) || cause.code !== 'MODEL_OUTPUT_INVALID') throw cause;
      if (stop !== undefined) return { ended: stop.ended };
      plannerFailures += 1;
      if (plannerFailures > 1) return { ended: 'aborted' };
      plan = state.steps.length === 0 ? SURVEY_STEP : CONTINUE_STEP;
    }
    if (plan.kind === 'finish') return { ended: stop?.ended ?? 'finished', summary: plan.summary };
    // Asked to finish, the model planned a step anyway: the budget wins.
    if (stop !== undefined) return { ended: stop.ended };

    // The plan call took its own time; a step still has to fit before the
    // reserve, or the run is out of time whatever the check above said.
    const room = remaining() - FINISH_RESERVE_MS;
    if (room < MIN_STEP_MS) return { ended: 'time' };
    const step = state.beginStep(plan.title, plan.instruction);
    const params = stepParams(state, loop.secrets);
    try {
      const result = await agent.act(step.instruction, {
        timeout: Math.min(loop.stepTimeoutMs, room),
        ...(params === undefined ? {} : { params }),
      });
      state.endStep('passed', result.summary);
    } catch (cause) {
      if (!isAgentError(cause)) throw cause;
      state.endStep(stepStatus(cause), cause.explanation, cause.code);
      if (cause.code === 'CANCELLED') throw cause;
    }
  }
}

/** Why the loop can no longer start a step, if it cannot. */
function mustFinish(
  state: ExploreState,
  remainingMs: number,
): { readonly ended: ReportExplore['ended']; readonly reason: string } | undefined {
  if (state.steps.length >= state.budgets.maxSteps) {
    return { ended: 'step-limit', reason: `the step limit of ${state.budgets.maxSteps} is reached` };
  }
  const streak = state.consecutiveFailures();
  if (streak >= CONSECUTIVE_FAILURE_LIMIT) {
    return { ended: 'stuck', reason: `${streak} steps failed in a row without a finding; exploration is stuck` };
  }
  if (remainingMs < FINISH_RESERVE_MS + MIN_STEP_MS) {
    return { ended: 'time', reason: 'the time budget is nearly spent' };
  }
  return undefined;
}

/**
 * The step parameters a charter carries: the findings so far, so the agent
 * neither reports one twice nor spends the step re-confirming it, and the
 * configured accounts as secrets it can fill by name. Undefined when there
 * is nothing to carry.
 */
function stepParams(state: ExploreState, secrets: AgentParams | undefined): AgentParams | undefined {
  const reported = state.findings.map((finding) => finding.title);
  const params: AgentParams = {
    ...(reported.length === 0 ? {} : { reportedFindings: reported }),
    ...(secrets === undefined ? {} : { credentials: secrets }),
  };
  return Object.keys(params).length === 0 ? undefined : params;
}

/** How a step that threw ended: a charter that ran out of room ended, it did not fail. */
function stepStatus(cause: AgentError): ReportExploreStep['status'] {
  if (cause.code === 'STEP_BUDGET_EXHAUSTED' || cause.code === 'STEP_TIMEOUT') return 'exhausted';
  return cause.code === 'CANCELLED' || cause.blocked ? 'blocked' : 'failed';
}

/** The first charter when the planner could not write one: look around. */
const SURVEY_STEP: PlanDecision = {
  kind: 'step',
  title: 'Survey the app',
  instruction:
    'Survey the app: visit each top-level page or screen the navigation offers once, note what each one is for and which controls it has, and try one obvious action on each. Report any defect you see on the way.',
};

/** A later charter when the planner could not write one: carry on with what the goal names and no step covered. */
const CONTINUE_STEP: PlanDecision = {
  kind: 'step',
  title: 'Continue exploring',
  instruction:
    'Continue the exploration: from the goal in the project context and the previously completed steps, pick the flow or screen the goal names that no step has covered yet, exercise it end to end with realistic inputs, and report any defect you see on the way.',
};

/** Turns the record into the run's verdict. */
function conclude(state: ExploreState): void {
  if (state.steps.length === 0 && state.findings.length === 0) {
    throw new AgentError(
      'AUTOMATION_UNSUPPORTED',
      'exploration concluded nothing: no step ran and no finding was recorded',
      { blocked: true },
    );
  }
  const issues = state.issues;
  if (issues.length > 0) {
    const titles = issues.map((finding) => `[severity ${finding.severity}] ${finding.title}`).join('; ');
    throw new AgentError('ASSERTION_FAILED', `exploration found ${issues.length} issue(s): ${titles}`);
  }
  const first = state.steps[0];
  if (first !== undefined && state.steps.every((step) => step.status === 'blocked')) {
    const code = first.errorCode as AgentErrorCode | undefined;
    throw new AgentError(
      code !== undefined && BLOCKABLE_CODES.has(code) ? code : 'AUTOMATION_UNSUPPORTED',
      `exploration could not complete a charter: ${first.summary ?? first.title}`,
      { blocked: true },
    );
  }
}
