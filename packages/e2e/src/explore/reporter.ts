/**
 * The exploration summary under the run summary: a `Reporter` whose
 * `onRunFinished` rows the list reporter prints, so the findings appear where
 * a reporter's own rows do, and the JSON reporter is left to the report.
 */

import type { Reporter, ReporterSummary } from '../types.ts';
import type { ExploreState } from './state.ts';

export function exploreReporter(state: ExploreState): Reporter {
  return {
    name: 'explore',
    onRunFinished: async () => summaryRows(state),
  };
}

/** The rows: what was explored, what was found, one row per finding, and the assessment. */
export function summaryRows(state: ExploreState): ReporterSummary {
  const counts = { passed: 0, failed: 0, blocked: 0, exhausted: 0 };
  for (const step of state.steps) counts[step.status] += 1;
  const parts = [
    `${counts.passed} passed`,
    ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
    ...(counts.exhausted > 0 ? [`${counts.exhausted} ended at their limit`] : []),
    ...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
  ];
  const issues = state.issues.length;
  const warnings = state.findings.length - issues;
  const rows: { label: string; text: string }[] = [
    {
      label: 'Explored',
      text: `${state.steps.length} step${state.steps.length === 1 ? '' : 's'} (${parts.join(', ')}); ended: ${ENDED_TEXT[state.ended]}`,
    },
    {
      label: 'Findings',
      text:
        state.findings.length === 0
          ? 'none'
          : `${issues} issue${issues === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
    },
  ];
  for (const finding of [...state.findings].toSorted((a, b) => b.severity - a.severity || a.index - b.index)) {
    rows.push({
      label: `  S${finding.severity} ${finding.kind}`,
      text: `${finding.title}${finding.path === undefined ? '' : ` (${finding.path})`}`,
    });
  }
  if (state.summary !== undefined) rows.push({ label: 'Assessment', text: state.summary });
  return rows;
}

const ENDED_TEXT: Record<ExploreState['ended'], string> = {
  finished: 'the agent covered the goal',
  'step-limit': 'the step limit was reached',
  time: 'the time budget ran out',
  stuck: 'steps kept failing',
  aborted: 'the run was cut short',
};
