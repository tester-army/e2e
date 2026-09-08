/**
 * The run digest a coding agent reads instead of `report.json`: what failed,
 * where in the test file, with which code and message, which step, and which
 * artifacts hold the evidence. Pure over the report-1 document, so it renders
 * the same for a run that just finished and for a report read from disk.
 */

import path from 'node:path';
import type { Report1Document, ReportAttempt, ReportSerialMember, ReportStep } from '../report/build.ts';

/** How many failing steps of one attempt the digest lists. */
const MAX_STEPS_PER_FAILURE = 5;
/** How many characters of a message the digest keeps on one line. */
const MAX_MESSAGE_CHARS = 600;

export interface DigestOptions {
  /** Where the report's relative artifact paths resolve from, normally `.e2e/artifacts`. */
  readonly artifactsRoot?: string;
  /** Where the canonical report was written, when it was. */
  readonly reportPath?: string;
}

/** Renders one report as markdown for an agent. */
export function digestReport(report: Report1Document, options: DigestOptions = {}): string {
  const { run } = report;
  const { summary } = run;
  const lines: string[] = [];
  lines.push(`# Run ${run.status} (exit ${run.exitCode})`);
  lines.push('');
  lines.push(
    `${summary.executed} executed, ${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky, ${summary.skipped} skipped of ${summary.selected} selected (${summary.discovered} discovered). ` +
      `Duration ${formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}.`,
  );
  if (run.usage.modelTokens > 0) {
    const cost = run.usage.estimatedCostUsd === undefined ? '' : `, about $${run.usage.estimatedCostUsd.toFixed(4)}`;
    lines.push(`Model usage: ${run.usage.modelTokens} tokens${cost}.`);
  }
  if (options.reportPath !== undefined) lines.push(`Report: ${options.reportPath}`);

  if (run.errors.length > 0) {
    lines.push('', '## Run errors', '');
    for (const error of run.errors) {
      const phase = error.phase === undefined ? '' : ` during ${error.phase}`;
      lines.push(`- ${error.code}${phase}: ${bound(error.message)}`);
    }
  }

  const failures = run.results.filter((result) => result.status === 'failed' || result.status === 'timed-out');
  const failedGroups = run.serialGroups.filter((group) => group.status === 'failed' || group.status === 'timed-out');
  if (failures.length === 0 && failedGroups.length === 0) {
    lines.push('', run.status === 'passed' ? 'Every selected test passed.' : 'No test failed.');
    return lines.join('\n');
  }

  lines.push('', `## Failed tests (${failures.length})`);
  for (const result of failures) {
    lines.push('', `### ${result.titlePath.join(' › ')}`, '');
    lines.push(`- File: ${result.source.file}:${result.source.line}`);
    lines.push(`- Target: ${result.targetId} (${result.platform}); status ${result.status}`);
    if (result.serialGroupId !== undefined) {
      const group = run.serialGroups.find((candidate) => candidate.id === result.serialGroupId);
      const member = group?.attempts.at(-1)?.members.find((candidate) => candidate.testId === result.testId);
      if (member !== undefined) lines.push(...describeMember(member, options));
      continue;
    }
    const attempt = result.attempts.at(-1);
    if (attempt === undefined) {
      lines.push('- No attempt ran.');
      continue;
    }
    if (result.attempts.length > 1) lines.push(`- Attempts: ${result.attempts.length}; the last one is described below.`);
    lines.push(...describeAttempt(attempt, options));
  }
  return lines.join('\n');
}

function describeAttempt(attempt: ReportAttempt, options: DigestOptions): string[] {
  const lines: string[] = [];
  if (attempt.error !== undefined) {
    const phase = attempt.error.phase === undefined ? '' : ` in ${attempt.error.phase}`;
    lines.push(`- Error${phase}: ${attempt.error.code} (${attempt.error.category}): ${bound(attempt.error.message)}`);
  }
  lines.push(...describeSteps(attempt.steps));
  const artifacts = attempt.artifacts
    .filter((artifact) => artifact.path !== undefined)
    .map((artifact) => `${artifact.kind} ${resolveArtifact(artifact.path!, options)}`);
  if (artifacts.length > 0) lines.push(`- Artifacts: ${artifacts.join('; ')}`);
  if (attempt.cleanup !== 'complete') lines.push(`- Cleanup: ${attempt.cleanup}`);
  for (const secondary of attempt.secondaryErrors) {
    lines.push(`- Also failed${secondary.phase === undefined ? '' : ` in ${secondary.phase}`}: ${secondary.code}: ${bound(secondary.message)}`);
  }
  return lines;
}

function describeMember(member: ReportSerialMember, _options: DigestOptions): string[] {
  const lines: string[] = [];
  if (member.error !== undefined) {
    lines.push(`- Error: ${member.error.code} (${member.error.category}): ${bound(member.error.message)}`);
  }
  if (member.skip !== undefined) lines.push(`- Skipped (${member.skip.cause}): ${member.skip.reason}`);
  lines.push(...describeSteps(member.steps));
  return lines;
}

function describeSteps(steps: readonly ReportStep[]): string[] {
  const failing = steps.filter((step) => step.status !== 'passed');
  if (failing.length === 0) {
    const last = steps.at(-1);
    return last === undefined ? [] : [`- Last step: ${describeStep(last)}`];
  }
  const lines = failing.slice(0, MAX_STEPS_PER_FAILURE).map((step) => `- Failing step: ${describeStep(step)}`);
  if (failing.length > MAX_STEPS_PER_FAILURE) lines.push(`- ${failing.length - MAX_STEPS_PER_FAILURE} more failing steps in the report.`);
  return lines;
}

function describeStep(step: ReportStep): string {
  const label = step.label === '' ? step.api : `${step.api} ${JSON.stringify(bound(step.label, 120))}`;
  const parts = [`${label} at ${step.source.file}:${step.source.line} (${step.status}, ${formatDuration(step.durationMs)})`];
  if (step.error !== undefined) parts.push(`${step.error.code}: ${bound(step.error.message)}`);
  if (step.explanation !== undefined) parts.push(`agent: ${bound(step.explanation)}`);
  if (step.metrics !== undefined && step.metrics.modelCalls > 0) {
    parts.push(`${step.metrics.modelCalls} model calls, ${step.metrics.actionSteps} actions`);
  }
  return parts.join('; ');
}

function resolveArtifact(relative: string, options: DigestOptions): string {
  return options.artifactsRoot === undefined ? relative : path.join(options.artifactsRoot, relative);
}

function bound(text: string, max = MAX_MESSAGE_CHARS): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
