/**
 * Benchmark knobs for how explore manages context, read from
 * `E2E_EXPLORE_EXPERIMENT` so the testbed's bench can run arms through the
 * CLI without a public flag for each. Not documented for users: every knob
 * off is the product behavior, and the variable is for measuring, not for
 * configuring a project.
 */

export interface ExploreExperiment {
  /** Pass the titles reported so far as step params (dedupe); off tests what that buys. */
  readonly findingsInParams: boolean;
  /** Give the planner the explicit steps-and-findings record; off leaves it the ledger alone. */
  readonly plannerHistory: boolean;
  /** One long conversation with start/finish tools instead of one act per charter. */
  readonly conversation: boolean;
}

export const DEFAULT_EXPERIMENT: ExploreExperiment = { findingsInParams: true, plannerHistory: true, conversation: false };

const KNOBS: Readonly<Record<string, Partial<ExploreExperiment>>> = {
  'no-findings-params': { findingsInParams: false },
  'planner-no-history': { plannerHistory: false },
  conversation: { conversation: true },
};

/** Parses the comma-separated knob list; an unknown knob is ignored rather than failing a run. */
export function readExperiment(env: NodeJS.ProcessEnv): ExploreExperiment {
  const raw = env['E2E_EXPLORE_EXPERIMENT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXPERIMENT;
  const experiment: { -readonly [Key in keyof ExploreExperiment]: ExploreExperiment[Key] } = { ...DEFAULT_EXPERIMENT };
  for (const knob of raw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    Object.assign(experiment, KNOBS[knob]);
  }
  return experiment;
}
