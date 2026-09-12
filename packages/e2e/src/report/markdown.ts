/**
 * The report-1 document as one markdown page, laid out for a pull request:
 * a headline with the counts and what the run spent, the run-level errors,
 * one block per test that failed or was flaky with the step it went wrong
 * at and the agent's last word, a table with one row per test file, and
 * every test folded away under it, grouped by file. An `e2e explore` run
 * renders its record instead: the goal, every finding with its evidence,
 * and the assessment. The built-in `markdown` reporter writes the page as
 * `summary.md` beside `report.json`; `@e2edev/github` posts it as the pull
 * request comment; a hosted run page renders the same text.
 *
 * Everything a test or the agent wrote (titles, labels, error messages,
 * findings) is untrusted text on its way into markdown a renderer trusts,
 * so it is escaped and clipped, and the whole body never outgrows what
 * GitHub accepts.
 */

import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Reporter } from '../types.ts';
import type {
  Report1Document,
  ReportError,
  ReportExplore,
  ReportExploreFinding,
  ReportResult,
  ReportSerialGroup,
  ReportStep,
} from './build.ts';
import { writeTextReport } from './write.ts';

type ReportRun = Report1Document['run'];
type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];
type ArtifactKind = ReportArtifact['kind'];

export interface MarkdownReportOptions {
  /** A hidden HTML comment a reporter finds its own comment by; left out of a file or a job summary. */
  readonly marker?: string | undefined;
  /** Where the run's artifacts can be fetched: the workflow run page, or a hosted run page. Evidence links there. */
  readonly artifactsUrl?: string | undefined;
  /**
   * The directory the report's artifact paths are relative to, as the reader
   * should see it (`.e2e/artifacts` for a file the project root is read
   * from). Without `artifactsUrl`, evidence is listed as paths under it.
   */
  readonly artifactsDir?: string | undefined;
  /** A link to a source line, when the commit is known. */
  readonly sourceUrl?: ((file: string, line: number) => string) | undefined;
}

/** GitHub rejects a comment body past 65536 characters; stay clear of it. */
const MAX_BODY_CHARS = 60_000;
/** Reader caps, not size guards: past these the page says how many more there are. */
const MAX_FAILURE_BLOCKS = 30;
const MAX_FILE_ROWS = 200;
const MAX_RUN_ERRORS = 20;
const MAX_LISTED_TESTS = 400;
const MAX_FOOTER_TARGETS = 8;
const MAX_FINDINGS = 30;
const MAX_EVIDENCE_PATHS = 3;
/** Steps shown in a failure's timeline before the passed run collapses to a count. */
const MAX_TIMELINE_STEPS = 6;
const MAX_CELL_CHARS = 240;
const MAX_LABEL_CHARS = 60;
/** Prose fields (a finding's expected and actual, the agent's explanation) get more room than a cell. */
const MAX_DETAIL_CHARS = 600;
const MAX_REPRODUCTION_CHARS = 200;
const TRUNCATED_NOTE = '_Truncated to fit a pull request comment; the full report is in `report.json`._';
/**
 * A marker is what a rerun finds the comment by, so it can never be cut. With
 * it bounded, the head and footer together stay far under the budget and the
 * body is the only part that ever gives way.
 */
export const MAX_MARKER_CHARS = 1_024;
/** The artifacts link sits in the footer beside the marker, so it is bounded the same way. */
export const MAX_URL_CHARS = 2_048;

/** C0/C1 control characters except tab and newline; ANSI sequences are stripped first. */
// oxlint-disable-next-line no-control-regex -- the control range is the point
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** One line of plain text: no color codes, no control characters, no line breaks. */
function plain(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

/** Clips by code point, so an emoji at the cut never becomes a lone surrogate. */
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Text safe inside a table cell or a list item: markdown that could open a
 * construct is escaped, angle brackets become entities so no HTML gets
 * through, and the cell separator is escaped. An underscore stays: inside a
 * word GitHub never reads it as emphasis, and error codes are full of them.
 */
function cell(text: string, max = MAX_CELL_CHARS): string {
  return clip(plain(text), max)
    .replace(/[\\`*[\]~|]/g, (char) => `\\${char}`)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** A path or label inside backticks: only the backtick itself has to go. */
function code(text: string, max = MAX_CELL_CHARS): string {
  return `\`${clip(plain(text), max).replaceAll('`', '').replaceAll('|', '\\|')}\``;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  // Round to whole seconds first, so 119.5 s is 2m 0s and never 1m 60s.
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What a result left behind, wherever the report keeps it. A serial member's
 * result has no attempts of its own: its error, duration, and steps live on
 * the group's final attempt, keyed by test id. The evidence is the union over
 * every attempt, since a flaky test's failure screenshot belongs to the
 * attempt that failed, not to the one that passed.
 */
interface Outcome {
  readonly durationMs: number;
  readonly error: ReportError | undefined;
  /** The final attempt's steps: where a failure is placed and what the agent did. */
  readonly steps: readonly ReportStep[];
  /** Attempts that did not pass before the final one; what a flaky pass cost. */
  readonly failedAttempts: number;
  /** The last failed attempt's error, when a later attempt passed: what a flaky test hit. */
  readonly earlierError: ReportError | undefined;
  readonly artifacts: readonly ReportArtifact[];
}

function outcome(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): Outcome {
  const attempts = result.serialGroupId === undefined ? result.attempts : (groups.get(result.serialGroupId)?.attempts ?? []);
  const last = attempts.at(-1);
  const member =
    result.serialGroupId === undefined || last === undefined || !('members' in last)
      ? undefined
      : last.members.find((candidate) => candidate.testId === result.testId);
  return {
    durationMs: member?.durationMs ?? last?.durationMs ?? 0,
    error: member?.error ?? last?.error,
    steps: member?.steps ?? (last !== undefined && 'steps' in last ? last.steps : []),
    failedAttempts: attempts.slice(0, -1).filter((attempt) => attempt.status !== 'passed').length,
    earlierError: attempts
      .slice(0, -1)
      .toReversed()
      .find((attempt) => attempt.status !== 'passed')?.error,
    artifacts: attempts.flatMap((attempt) => attempt.artifacts),
  };
}

/** Screenshots first, then the recording, then the trace; the compiler fails when a kind is missing here. */
const KIND_RANK: Record<ArtifactKind, number> = { screenshot: 0, video: 1, trace: 2, download: 3, log: 4 };

function byKind(artifacts: readonly ReportArtifact[]): ReportArtifact[] {
  return artifacts.toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

function kinds(artifacts: readonly ReportArtifact[]): ArtifactKind[] {
  return [...new Set(byKind(artifacts).map((artifact) => artifact.kind))];
}

type Bucket = 'failed' | 'flaky' | 'skipped' | 'passed';

function bucket(status: ReportResult['status']): Bucket {
  return status === 'passed' || status === 'flaky' || status === 'skipped' ? status : 'failed';
}

const ICON: Record<Bucket, string> = { failed: '🔴', flaky: '⚠️', skipped: '⏭️', passed: '🟢' };
/** Worst first: the glyph a file gets is that of its worst test. */
const BUCKET_RANK: Record<Bucket, number> = { failed: 0, flaky: 1, skipped: 2, passed: 3 };
const COUNT_ORDER: readonly Bucket[] = ['failed', 'flaky', 'passed', 'skipped'];

function countBuckets(results: readonly ReportResult[]): Map<Bucket, number> {
  const counts = new Map<Bucket, number>();
  for (const result of results) {
    const key = bucket(result.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** `1 failed, 3 passed`, zero counts left out. */
function countText(counts: ReadonlyMap<Bucket, number>): string {
  return COUNT_ORDER.filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => `${counts.get(key)} ${key}`)
    .join(', ');
}

function headline(run: ReportRun, counts: ReadonlyMap<Bucket, number>): string {
  const summary = countText(counts) || (run.errors.length > 0 ? 'no tests ran' : 'no tests selected');
  return `### ${run.status === 'passed' ? ICON.passed : ICON.failed} e2e: ${summary}`;
}

/** What the agent did and what it cost, over the whole run. */
interface AgentTotals {
  steps: number;
  replayed: number;
  calls: number;
}

function agentTotals(steps: readonly ReportStep[]): AgentTotals {
  const totals: AgentTotals = { steps: 0, replayed: 0, calls: 0 };
  for (const step of steps) {
    if (step.kind !== 'agent') continue;
    totals.steps += 1;
    if (step.cache?.mode === 'self-finalized') totals.replayed += 1;
    totals.calls += step.metrics?.modelCalls ?? step.model?.calls ?? 0;
  }
  return totals;
}

/**
 * `41 agent steps · 12 replayed from cache · 128k tokens (62% cached) · $0.31`,
 * under the headline of a run that used the agent; a deterministic run has
 * nothing to say here.
 */
function spendLine(run: ReportRun, outcomes: readonly Outcome[]): string[] {
  const totals = agentTotals(outcomes.flatMap((final) => final.steps));
  if (totals.steps === 0 && run.usage.modelTokens === 0) return [];
  const parts = [plural(totals.steps, 'agent step')];
  if (totals.replayed > 0) parts.push(`${totals.replayed} replayed from cache`);
  if (totals.calls > 0) parts.push(plural(totals.calls, 'model call'));
  if (run.usage.modelTokens > 0) {
    const cached = run.usage.modelCachedTokens;
    const share = cached === undefined || cached === 0 ? '' : ` (${Math.round((cached / run.usage.modelTokens) * 100)}% cached)`;
    parts.push(`${formatTokens(run.usage.modelTokens)} tokens${share}`);
  }
  if (run.usage.estimatedCostUsd !== undefined) parts.push(formatCost(run.usage.estimatedCostUsd));
  return [parts.join(' · ')];
}

function errorText(error: ReportError): string {
  const phase = error.phase === undefined ? '' : ` (${plain(error.phase)})`;
  return `**${cell(error.code, 128)}**${phase} ${cell(error.message)}`.trim();
}

/**
 * Where the evidence is: linked to the run page when there is one, listed as
 * paths under `artifactsDir` when the reader has the files, and named by
 * kind otherwise. Paths are POSIX, as the report keeps them.
 */
function evidence(artifacts: readonly ReportArtifact[], options: MarkdownReportOptions): string {
  if (artifacts.length === 0) return '';
  const named = kinds(artifacts).join(', ');
  if (options.artifactsUrl !== undefined) return `[${named}](${options.artifactsUrl})`;
  if (options.artifactsDir === undefined) return named;
  const files = byKind(artifacts).flatMap((artifact) => (artifact.path === undefined ? [] : [artifact.path]));
  if (files.length === 0) return named;
  const shown = files.slice(0, MAX_EVIDENCE_PATHS).map((file) => code(path.posix.join(options.artifactsDir!, file)));
  if (files.length > shown.length) shown.push(`and ${files.length - shown.length} more`);
  return shown.join(', ');
}

// --- a test that did not pass ---

const STEP_GLYPH: Record<ReportStep['status'], string> = { passed: '✓', failed: '✗', blocked: '✗', 'timed-out': '✗', cancelled: '–' };

/**
 * The step a failure happened at, in one sentence: its position, its api and
 * label, how long it ran, and for an agent step the model calls it spent and
 * the agent's own explanation of what it saw.
 */
function failedStepLine(steps: readonly ReportStep[]): string | undefined {
  const index = steps.findIndex((step) => step.status !== 'passed');
  if (index === -1) return undefined;
  const step = steps[index]!;
  const calls = step.metrics?.modelCalls ?? step.model?.calls;
  const spent = calls === undefined || calls === 0 ? '' : ` after ${plural(calls, 'model call')}`;
  const explanation = step.explanation === undefined || step.explanation.trim() === '' ? '' : `: "${cell(step.explanation, MAX_DETAIL_CHARS)}"`;
  const verb = step.status === 'cancelled' ? 'was cancelled' : step.status === 'timed-out' ? 'timed out' : step.status === 'blocked' ? 'was blocked' : 'failed';
  return `Step ${index + 1} of ${steps.length}, ${code(step.api, 64)} "${cell(step.label, MAX_LABEL_CHARS)}", ${verb}${spent} in ${formatDuration(step.durationMs)}${explanation}`;
}

/**
 * `Steps: ✓ open the app › ✓ sign in › ✗ accept the invitation › 2 not run`:
 * the attempt's timeline up to the failure, a long passed run collapsed to a
 * count so the failing step stays in view.
 */
function timelineLine(steps: readonly ReportStep[]): string | undefined {
  if (steps.length < 2) return undefined;
  const failedAt = steps.findIndex((step) => step.status !== 'passed');
  const end = failedAt === -1 ? steps.length : failedAt + 1;
  const shown = steps.slice(0, end);
  const parts: string[] = [];
  const collapse = shown.length > MAX_TIMELINE_STEPS ? shown.length - MAX_TIMELINE_STEPS + 1 : 0;
  if (collapse > 1) parts.push(`✓ ${plural(collapse, 'passed step')}`);
  for (const step of collapse > 1 ? shown.slice(collapse) : shown) parts.push(`${STEP_GLYPH[step.status]} ${cell(step.label, MAX_LABEL_CHARS)}`);
  const notRun = steps.length - end;
  if (notRun > 0) parts.push(`${notRun} not run`);
  return `Steps: ${parts.join(' › ')}`;
}

/** The location, linked to the commit when known, else in backticks. */
function location(result: ReportResult, options: MarkdownReportOptions): string {
  const text = `${result.source.file}:${result.source.line}`;
  return options.sourceUrl === undefined ? code(text) : `[${cell(text)}](${options.sourceUrl(result.source.file, result.source.line)})`;
}

/** `file › suite › title (target)`, the target named only when the run has several. */
function testName(result: ReportResult, manyTargets: boolean, withFile: boolean): string {
  const title = result.titlePath.map((part) => cell(part, 120)).join(' › ');
  const file = withFile ? `${cell(result.file, 200)} › ` : '';
  return `${file}${title}${manyTargets ? ` (${cell(result.targetId, 64)})` : ''}`;
}

/**
 * One block per test that failed or was flaky: what went wrong, at which
 * step, what the agent said, the evidence, and the source line. Lines end in
 * two spaces so GitHub keeps the breaks inside one paragraph.
 */
function failureBlock(result: ReportResult, final: Outcome, manyTargets: boolean, options: MarkdownReportOptions): string {
  const kind = bucket(result.status);
  const lines = [`**${ICON[kind]} ${testName(result, manyTargets, true)}**`];
  if (kind === 'flaky') {
    const hit = final.earlierError === undefined ? '' : `; the last one hit ${errorText(final.earlierError)}`;
    lines.push(`Passed after ${plural(final.failedAttempts, 'failed attempt')}${hit}.`);
  }
  if (final.error !== undefined) lines.push(errorText(final.error));
  const step = failedStepLine(final.steps);
  if (step !== undefined) lines.push(step);
  const timeline = timelineLine(final.steps);
  if (timeline !== undefined) lines.push(timeline);
  const where = evidence(final.artifacts, options);
  lines.push(`${where === '' ? '' : `Evidence: ${where} · `}${location(result, options)}`);
  return lines.join('  \n');
}

// --- the file table ---

interface FileRow {
  readonly file: string;
  readonly target: string;
  readonly results: readonly ReportResult[];
  readonly outcomes: readonly Outcome[];
}

function fileRows(results: readonly ReportResult[], finals: ReadonlyMap<ReportResult, Outcome>): FileRow[] {
  const rows = new Map<string, { file: string; target: string; results: ReportResult[]; outcomes: Outcome[] }>();
  for (const result of results) {
    const key = `${result.targetId}\u0000${result.file}`;
    const row = rows.get(key) ?? { file: result.file, target: result.targetId, results: [], outcomes: [] };
    row.results.push(result);
    row.outcomes.push(finals.get(result)!);
    rows.set(key, row);
  }
  const worst = (row: FileRow): number => Math.min(...row.results.map((result) => BUCKET_RANK[bucket(result.status)]));
  return [...rows.values()].toSorted((a, b) => worst(a) - worst(b) || a.file.localeCompare(b.file) || a.target.localeCompare(b.target));
}

function fileTable(rows: readonly FileRow[], manyTargets: boolean): string[] {
  if (rows.length === 0) return [];
  const lines = ['| | File | Tests | Agent | Time |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows.slice(0, MAX_FILE_ROWS)) {
    const counts = countBuckets(row.results);
    const glyph = ICON[COUNT_ORDER.find((key) => (counts.get(key) ?? 0) > 0) ?? 'passed'];
    const totals = agentTotals(row.outcomes.flatMap((final) => final.steps));
    const agent = totals.steps === 0 ? '' : `${plural(totals.steps, 'step')}${totals.calls > 0 ? ` · ${plural(totals.calls, 'call')}` : ''}`;
    const time = formatDuration(row.outcomes.reduce((total, final) => total + final.durationMs, 0));
    const file = `${cell(row.file, 200)}${manyTargets ? ` (${cell(row.target, 64)})` : ''}`;
    lines.push(`| ${glyph} | ${file} | ${countText(counts)} | ${agent} | ${time} |`);
  }
  if (rows.length > MAX_FILE_ROWS) lines.push(`| | and ${rows.length - MAX_FILE_ROWS} more files | | | |`);
  return lines;
}

/** Every test, grouped by file in the table's order, folded away; one block since a `<details>` cannot be cut halfway. */
function allTests(rows: readonly FileRow[], finals: ReadonlyMap<ReportResult, Outcome>, total: number, manyTargets: boolean): string[] {
  if (total === 0) return [];
  const lines = ['<details>', `<summary>All ${plural(total, 'test')}</summary>`, ''];
  let listed = 0;
  outer: for (const row of rows) {
    lines.push(`**${cell(row.file, 200)}${manyTargets ? ` (${cell(row.target, 64)})` : ''}**`);
    for (const result of row.results) {
      if (listed >= MAX_LISTED_TESTS) {
        lines.push(`- and ${total - listed} more`);
        break outer;
      }
      const final = finals.get(result)!;
      const note =
        result.status === 'skipped'
          ? ` (skipped: ${cell(result.skip?.reason ?? 'skipped')})`
          : result.status === 'flaky'
            ? ` (${formatDuration(final.durationMs)}, ${plural(final.failedAttempts, 'failed attempt')} first)`
            : ` (${formatDuration(final.durationMs)})`;
      lines.push(`- ${ICON[bucket(result.status)]} ${testName(result, manyTargets, false)}${note}`);
      listed += 1;
    }
    lines.push('');
  }
  if (lines.at(-1) === '') lines.pop();
  lines.push('</details>');
  return [lines.join('\n')];
}

function footer(run: ReportRun, options: MarkdownReportOptions): string[] {
  const duration = formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const shown = run.targets.slice(0, MAX_FOOTER_TARGETS).map((target) => cell(target.id, 64));
  if (run.targets.length > shown.length) shown.push(`and ${run.targets.length - shown.length} more`);
  const targets = shown.length === 0 ? '' : ` (${shown.join(', ')})`;
  return [
    ...(options.artifactsUrl === undefined
      ? []
      : [`Screenshots, traces, and recordings: [run artifacts](${options.artifactsUrl}).`]),
    `<sub>e2e ${cell(run.runner.version, 64)} · ${duration} · ${plural(run.targets.length, 'target')}${targets}</sub>`,
  ];
}

// --- the exploration record ---

const SEVERITY_WORDS: Record<ReportExploreFinding['severity'], string> = {
  5: 'critical',
  4: 'high',
  3: 'medium',
  2: 'low',
  1: 'trivial',
};

const ENDED_TEXT: Record<ReportExplore['ended'], string> = {
  finished: 'the agent covered the goal',
  'step-limit': 'the step limit was reached',
  time: 'the time budget ran out',
  stuck: 'steps kept failing',
  aborted: 'the run was cut short',
};

function exploreHeadline(run: ReportRun, explore: ReportExplore): string {
  const issues = explore.findings.filter((finding) => finding.kind === 'issue').length;
  const warnings = explore.findings.length - issues;
  const counts = [...(issues > 0 ? [plural(issues, 'issue')] : []), ...(warnings > 0 ? [plural(warnings, 'warning')] : [])];
  const summary =
    counts.length > 0 ? counts.join(', ') : run.status === 'blocked' ? 'explored nothing' : run.status === 'passed' ? 'no findings' : 'did not finish';
  return `### ${run.status === 'passed' ? ICON.passed : ICON.failed} e2e explore: ${summary}`;
}

/** `3 of 8 steps · 2 passed · 1 failed · the agent covered the goal`. */
function exploreSteps(explore: ReportExplore): string {
  const counts = { passed: 0, failed: 0, blocked: 0, exhausted: 0 };
  for (const step of explore.steps) counts[step.status] += 1;
  return [
    `${explore.steps.length} of ${explore.budgets.maxSteps} steps`,
    ...(counts.passed > 0 ? [`${counts.passed} passed`] : []),
    ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
    ...(counts.exhausted > 0 ? [`${counts.exhausted} ended at their limit`] : []),
    ...(counts.blocked > 0 ? [`${counts.blocked} blocked`] : []),
    ENDED_TEXT[explore.ended],
  ].join(' · ');
}

/**
 * One finding as a list item: grade and title, where it was seen, what was
 * expected against what the screen showed, the actions that reach it, and
 * its screenshot. Issues come before warnings and the most severe first, as
 * the terminal orders them.
 */
function findingBlock(
  finding: ReportExploreFinding,
  position: number,
  artifacts: ReadonlyMap<string, ReportArtifact>,
  options: MarkdownReportOptions,
): string {
  const where = [...(finding.path === undefined ? [] : [code(finding.path, 120)]), ...(finding.step === undefined ? [] : [`step ${finding.step}`])];
  const lines = [
    `${position}. **${SEVERITY_WORDS[finding.severity]} ${finding.kind}** ${cell(finding.title)}${where.length === 0 ? '' : ` · ${where.join(' · ')}`}`,
    `   Expected: ${cell(finding.expected, MAX_DETAIL_CHARS)}`,
    `   Actual: ${cell(finding.actual, MAX_DETAIL_CHARS)}`,
  ];
  if (finding.reproduction.length > 0) {
    lines.push(`   Steps: ${finding.reproduction.map((action, index) => `${index + 1}. ${cell(action, MAX_REPRODUCTION_CHARS)}`).join(' ')}`);
  }
  const screenshot = finding.artifactId === undefined ? undefined : artifacts.get(finding.artifactId);
  if (screenshot !== undefined) lines.push(`   Evidence: ${evidence([screenshot], options)}`);
  return lines.join('  \n');
}

/** The exploration's sections: the goal and steps, the findings, the assessment. */
function exploreSections(run: ReportRun, explore: ReportExplore, options: MarkdownReportOptions): string[][] {
  const artifacts = new Map(run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.artifacts)).map((artifact) => [artifact.id, artifact]));
  const ordered = explore.findings.toSorted(
    (a, b) => Number(a.kind === 'warning') - Number(b.kind === 'warning') || b.severity - a.severity || a.index - b.index,
  );
  const findings = ordered.slice(0, MAX_FINDINGS).map((finding, index) => findingBlock(finding, index + 1, artifacts, options));
  if (ordered.length > findings.length) findings.push(`${findings.length + 1}. and ${ordered.length - findings.length} more`);
  return [
    [`**Goal:** ${cell(explore.goal, 400)}  `, `**Steps:** ${exploreSteps(explore)}`],
    findings.length === 0 ? [] : ['**Findings**', '', ...findings],
    explore.summary === undefined ? [] : ['**Assessment**', '', cell(explore.summary, 2_000)],
  ];
}

/**
 * Whether a result's failure is the exploration's verdict, which the findings
 * already express; only a failure that is not gets a block of its own.
 */
function isVerdict(final: Outcome, explore: ReportExplore): boolean {
  return final.error?.code === 'ASSERTION_FAILED' && explore.findings.some((finding) => finding.kind === 'issue');
}

/** Renders the run as one markdown page: a pull request comment body, a job summary, or `summary.md`. */
export function renderMarkdownReport(report: Report1Document, options: MarkdownReportOptions = {}): string {
  if (options.marker !== undefined && options.marker.length > MAX_MARKER_CHARS) {
    throw new Error(`renderMarkdownReport: marker must be at most ${MAX_MARKER_CHARS} characters, got ${options.marker.length}`);
  }
  if (options.artifactsUrl !== undefined && options.artifactsUrl.length > MAX_URL_CHARS) {
    throw new Error(`renderMarkdownReport: artifactsUrl must be at most ${MAX_URL_CHARS} characters, got ${options.artifactsUrl.length}`);
  }
  const run = report.run;
  const explore = run.explore;
  const serialGroups = new Map(run.serialGroups.map((group) => [group.id, group]));
  const finals = new Map(run.results.map((result) => [result, outcome(result, serialGroups)] as const));
  const manyTargets = run.targets.length > 1;

  // Body parts in priority order; each is one line, except a failure block, a
  // finding, and the folded list, which are one block each since none can be
  // cut halfway.
  const errors = run.errors.slice(0, MAX_RUN_ERRORS).map((error) => `> ${errorText(error)}`);
  if (run.errors.length > errors.length) errors.push(`> and ${run.errors.length - errors.length} more`);
  // An exploration is the run's one test and its failure is the verdict the
  // findings express, so that block gives way to them; any other failure stays.
  const notPassed = run.results.filter((result) => {
    const kind = bucket(result.status);
    if (kind !== 'failed' && kind !== 'flaky') return false;
    return explore === undefined || !isVerdict(finals.get(result)!, explore);
  });
  // A blank line between blocks, so GitHub renders each as its own paragraph.
  const failures = notPassed.slice(0, MAX_FAILURE_BLOCKS).flatMap((result) => [failureBlock(result, finals.get(result)!, manyTargets, options), '']);
  if (notPassed.length > failures.length / 2) failures.push(`and ${notPassed.length - failures.length / 2} more did not pass`, '');
  failures.pop();

  const sections: string[][] = [];
  const head: string[] = options.marker === undefined ? [] : [options.marker];
  if (explore === undefined) {
    const rows = fileRows(run.results, finals);
    head.push(headline(run, countBuckets(run.results)), ...spendLine(run, [...finals.values()]), '');
    sections.push(errors, failures, fileTable(rows, manyTargets), allTests(rows, finals, run.results.length, manyTargets));
  } else {
    const [goal = [], ...rest] = exploreSections(run, explore, options);
    head.push(exploreHeadline(run, explore), ...spendLine(run, [...finals.values()]), '');
    sections.push(goal, errors, failures, ...rest);
  }
  const tail = footer(run, options);
  const render = (body: readonly string[]): string => `${[...head, ...body, ...tail].join('\n')}\n`;

  // Greedy fit: keep whole parts in order while they fit, then say what was cut.
  let size = render([TRUNCATED_NOTE]).length;
  const body: string[] = [];
  let cut = false;
  for (const section of sections.filter((entry) => entry.length > 0)) {
    for (const part of section) {
      if (size + part.length + 1 > MAX_BODY_CHARS) {
        cut = true;
        break;
      }
      body.push(part);
      size += part.length + 1;
    }
    if (cut) break;
    body.push('');
    size += 1;
  }
  return render(cut ? [...body, TRUNCATED_NOTE] : body);
}

/**
 * The built-in `markdown` reporter: the report as one markdown page in
 * `summary.md` beside `report.json`, with evidence listed as paths from the
 * project root, for a reader with the checkout in front of it: a pull
 * request description, a coding agent's handoff, a wiki page. Nothing to
 * write beside when the report itself was not written.
 */
export const markdownReporter: Reporter = {
  name: 'markdown',
  async onRunFinished(run) {
    if (run.reportPath === undefined) return;
    const file = path.join(path.dirname(run.reportPath), 'summary.md');
    const artifactsDir = path.relative(run.projectRoot, run.artifactsRoot).split(path.sep).join(path.posix.sep) || '.';
    await writeTextReport(file, renderMarkdownReport(run.report, { artifactsDir }));
    return [{ label: 'Markdown', text: path.relative(run.projectRoot, file) || file }];
  },
};
