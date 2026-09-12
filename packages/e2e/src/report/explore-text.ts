/**
 * The words every reporter uses for an exploration record: severity grades,
 * why a run ended, how its steps fared, and the order findings are read in.
 * The terminal and the markdown page both render from here, so a wording
 * change lands in both at once.
 */

import type { ReportExplore, ReportExploreFinding, ReportExploreStep } from './build.ts';

export const SEVERITY_WORDS: Record<ReportExploreFinding['severity'], string> = {
  5: 'critical',
  4: 'high',
  3: 'medium',
  2: 'low',
  1: 'trivial',
};

export const ENDED_TEXT: Record<ReportExplore['ended'], string> = {
  finished: 'the agent covered the goal',
  'step-limit': 'the step limit was reached',
  time: 'the time budget ran out',
  stuck: 'steps kept failing',
  aborted: 'the run was cut short',
};

/** Issues before warnings, the most severe first, then in the order reported. */
export function orderFindings(findings: readonly ReportExploreFinding[]): ReportExploreFinding[] {
  return findings.toSorted(
    (a, b) => Number(a.kind === 'warning') - Number(b.kind === 'warning') || b.severity - a.severity || a.index - b.index,
  );
}

/** `3 passed`, `1 failed`, `2 ended at their limit`, `1 blocked` over the steps, zero counts left out, each with its status for coloring. */
export function stepCountParts(steps: readonly ReportExploreStep[]): { readonly status: ReportExploreStep['status']; readonly text: string }[] {
  const counts: Record<ReportExploreStep['status'], number> = { passed: 0, failed: 0, blocked: 0, exhausted: 0 };
  for (const step of steps) counts[step.status] += 1;
  return [
    ...(counts.passed > 0 ? [{ status: 'passed' as const, text: `${counts.passed} passed` }] : []),
    ...(counts.failed > 0 ? [{ status: 'failed' as const, text: `${counts.failed} failed` }] : []),
    ...(counts.exhausted > 0 ? [{ status: 'exhausted' as const, text: `${counts.exhausted} ended at their limit` }] : []),
    ...(counts.blocked > 0 ? [{ status: 'blocked' as const, text: `${counts.blocked} blocked` }] : []),
  ];
}
