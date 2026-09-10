/**
 * The exploration body: the test `e2e explore` registers in memory. A loop
 * of ordinary `agent.act` steps, one per charter the planner writes, under
 * the exploration's own budgets. The outcome policy is the one TesterArmy's
 * discovery runs settled on: a step that ends at its budget is a time-boxed
 * charter and not a failure; a failed step is a finding and the run goes on;
 * three failed or blocked steps in a row, the step cap, or the clock end the
 * run with a closing assessment; findings of kind `issue` fail the run; a run
 * that explored nothing and found nothing is blocked, never a pass.
 */

import { AgentError, isAgentError } from '../agent/error.ts';
import type { ReportExplore } from '../report/build.ts';
import type { TestFn } from '../types.ts';
import { planNext, type PlanDecision } from './plan.ts';
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
   * URL; a device target without one is already showing the app when the
   * attempt starts.
   */
  readonly openApp: boolean;
  readonly now?: (() => number) | undefined;
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

/** The first charter when the planner could not write one: look around. */
const SURVEY_STEP: PlanDecision = {
  kind: 'step',
  title: 'Survey the app',
  instruction:
    'Survey the app: visit each top-level page or screen the navigation offers once, note what each one is for and which controls it has, and try one obvious action on each. Report any defect you see on the way.',
};

/** Builds the test body for one exploration. */
export function createExploreBody(options: ExploreBodyOptions): TestFn {
  const { state } = options;
  const now = options.now ?? Date.now;
  return async ({ agent, app }) => {
    const deadline = now() + state.budgets.timeoutMs;
    const remaining = (): number => deadline - now();

    if (options.openApp) await app.open();

    for (;;) {
      const stop = mustFinish(state, remaining());
      if (stop !== undefined && remaining() < MIN_PLAN_TIMEOUT_MS) {
        state.ended = stop.ended;
        break;
      }
      let plan: PlanDecision;
      try {
        plan = await planNext(agent, state, {
          mustFinish: stop !== undefined,
          reason: stop?.reason,
          remainingMs: remaining(),
          timeoutMs: Math.max(MIN_PLAN_TIMEOUT_MS, Math.min(PLAN_TIMEOUT_MS, remaining())),
        });
      } catch (cause) {
        // A model that cannot produce a plan in the grammar, even after the
        // repair round, is a model shortcoming, not the end of the world: the
        // first step falls back to a survey of the app, and a later failure
        // ends the exploration with the record so far. Anything else (the
        // provider, the clock, a cancellation) is the run's error.
        if (!isAgentError(cause) || cause.code !== 'MODEL_OUTPUT_INVALID' || stop !== undefined) {
          state.ended = 'aborted';
          throw cause;
        }
        if (state.steps.length > 0) {
          state.ended = 'aborted';
          break;
        }
        plan = SURVEY_STEP;
      }
      if (plan.kind === 'finish') {
        state.summary = plan.summary;
        state.ended = stop?.ended ?? 'finished';
        break;
      }
      if (stop !== undefined) {
        // Asked to finish, the model planned a step anyway: the budget wins.
        state.ended = stop.ended;
        break;
      }

      // The plan call took its own time; a step still has to fit before the
      // reserve, or the run is out of time whatever the check above said.
      const room = remaining() - FINISH_RESERVE_MS;
      if (room < MIN_STEP_MS) {
        state.ended = 'time';
        break;
      }
      state.beginStep(plan.title, plan.instruction);
      const timeout = Math.min(options.stepTimeoutMs, room);
      // The findings so far ride along as step parameters, so the agent
      // neither reports one twice nor spends the step re-confirming it.
      const reported = state.findings.map((finding) => finding.title);
      try {
        const result = await agent.act(plan.instruction, {
          timeout,
          ...(reported.length === 0 ? {} : { params: { reportedFindings: reported } }),
        });
        state.endStep('passed', result.summary);
      } catch (cause) {
        if (!isAgentError(cause)) throw cause;
        if (cause.code === 'CANCELLED') {
          state.endStep('blocked', cause.explanation, cause.code);
          state.ended = 'aborted';
          throw cause;
        }
        if (cause.code === 'STEP_BUDGET_EXHAUSTED' || cause.code === 'STEP_TIMEOUT') {
          // A charter that ran out of room ended, it did not fail.
          state.endStep('exhausted', cause.explanation, cause.code);
        } else if (cause.blocked) {
          state.endStep('blocked', cause.explanation, cause.code);
        } else {
          state.endStep('failed', cause.explanation, cause.code);
        }
      }
    }

    conclude(state);
  };
}

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
}
