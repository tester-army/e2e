/**
 * The report-1 document as one markdown page: a headline with the counts,
 * the run-level errors, a table of every test that did not simply pass, the
 * passed tests folded away, and where the evidence is. An `e2e explore` run
 * renders its record instead: the goal, every finding with its evidence, and
 * the assessment. The built-in `markdown` reporter writes it as `summary.md`
 * beside `report.json`; `@e2edev/github` posts it as the pull request
 * comment; a hosted run page renders the same text.
 *
 * Everything a test or the agent wrote (titles, error messages, findings) is
 * untrusted text on its way into markdown a renderer trusts, so cells are
 * escaped and clipped, and the whole body never outgrows what GitHub accepts.
 */

import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Reporter } from '../types.ts';
import type { Report1Document, ReportError, ReportExplore, ReportExploreFinding, ReportResult, ReportSerialGroup } from './build.ts';
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
const MAX_TABLE_ROWS = 50;
const MAX_RUN_ERRORS = 20;
const MAX_PASSED_LINES = 200;
const MAX_FOOTER_TARGETS = 8;
const MAX_FINDINGS = 30;
const MAX_EVIDENCE_PATHS = 3;
const MAX_CELL_CHARS = 240;
/** A finding's expected and actual read as prose, so they get more room than a cell. */
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

/** A path inside backticks: the runner made it, so only the backtick itself has to go. */
function code(text: string, max = MAX_CELL_CHARS): string {
  return `\`${clip(plain(text), max).replaceAll('`', '')}\``;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  // Round to whole seconds first, so 119.5 s is 2m 0s and never 1m 60s.
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What a result left behind, wherever the report keeps it. A serial member's
 * result has no attempts of its own: its error and duration live on the
 * group's final attempt, keyed by test id. The evidence is the union over
 * every attempt, since a flaky test's failure screenshot belongs to the
 * attempt that failed, not to the one that passed.
 */
interface Outcome {
  readonly durationMs: number;
  readonly error: ReportError | undefined;
  /** Attempts that did not pass before the final one; what a flaky pass cost. */
  readonly failedAttempts: number;
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
    failedAttempts: attempts.slice(0, -1).filter((attempt) => attempt.status !== 'passed').length,
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

/** The order the table lists what did not pass; passed tests fold away below it. */
const LISTED: readonly Bucket[] = ['failed', 'flaky', 'skipped'];

function groupByBucket(results: readonly ReportResult[]): Map<Bucket, ReportResult[]> {
  const groups = new Map<Bucket, ReportResult[]>();
  for (const result of results) {
    const key = bucket(result.status);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return groups;
}

function headline(run: ReportRun, groups: ReadonlyMap<Bucket, readonly ReportResult[]>): string {
  const parts = (['failed', 'flaky', 'passed', 'skipped'] as const)
    .filter((key) => (groups.get(key)?.length ?? 0) > 0)
    .map((key) => `${groups.get(key)?.length} ${key}`);
  const summary = parts.length > 0 ? parts.join(', ') : run.errors.length > 0 ? 'no tests ran' : 'no tests selected';
  return `### ${run.status === 'passed' ? ICON.passed : ICON.failed} e2e: ${summary}`;
}

function errorText(error: ReportError): string {
  const phase = error.phase === undefined ? '' : ` (${plain(error.phase)})`;
  return `**${cell(error.code, 128)}**${phase} ${cell(error.message)}`.trim();
}

function outcomeCell(result: ReportResult, final: Outcome): string {
  if (result.status === 'flaky' && final.failedAttempts > 0) {
    return `flaky: passed after ${plural(final.failedAttempts, 'failed attempt')}`;
  }
  if (result.status === 'skipped') return `skipped: ${cell(result.skip?.reason ?? 'skipped')}`;
  return final.error === undefined ? cell(result.status) : errorText(final.error);
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
 * already express; the table lists only failures that are not.
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
  const groups = groupByBucket(run.results);
  const manyTargets = run.targets.length > 1;

  /** `file:line › suite › title (target)`, the location linked when the commit is known. */
  const name = (result: ReportResult, location: string): string => {
    const title = result.titlePath.map((part) => cell(part, 120)).join(' › ');
    return `${location} › ${title}${manyTargets ? ` (${cell(result.targetId, 64)})` : ''}`;
  };
  const linked = (result: ReportResult): string => {
    const location = `${result.source.file}:${result.source.line}`;
    return options.sourceUrl === undefined ? code(location) : `[${cell(location)}](${options.sourceUrl(result.source.file, result.source.line)})`;
  };

  // Body parts in priority order; each is one line, except a finding and the
  // passed list, which are one block each since neither can be cut halfway.
  const errors = run.errors.slice(0, MAX_RUN_ERRORS).map((error) => `> ${errorText(error)}`);
  if (run.errors.length > errors.length) errors.push(`> and ${run.errors.length - errors.length} more`);
  // An exploration is the run's one test and its failure is the verdict the
  // findings express, so that row gives way to them; any other failure stays.
  const listed = LISTED.flatMap((key) => groups.get(key) ?? []).filter(
    (result) => explore === undefined || !isVerdict(outcome(result, serialGroups), explore),
  );
  const rows = listed.slice(0, MAX_TABLE_ROWS).map((result) => {
    const final = outcome(result, serialGroups);
    return `| ${ICON[bucket(result.status)]} | ${name(result, linked(result))} | ${outcomeCell(result, final)} | ${evidence(final.artifacts, options)} |`;
  });
  const table = rows.length === 0 ? [] : ['| | Test | Outcome | Evidence |', '| --- | --- | --- | --- |', ...rows];
  if (listed.length > rows.length) table.push(`| | and ${listed.length - rows.length} more | | |`);
  const passed = explore === undefined ? (groups.get('passed') ?? []) : [];
  const passedBlock =
    passed.length === 0
      ? []
      : [
          [
            '<details>',
            `<summary>${plural(passed.length, 'passed test')}</summary>`,
            '',
            ...passed
              .slice(0, MAX_PASSED_LINES)
              .map((result) => `- ${name(result, cell(result.file, 200))} (${formatDuration(outcome(result, serialGroups).durationMs)})`),
            ...(passed.length > MAX_PASSED_LINES ? [`- and ${passed.length - MAX_PASSED_LINES} more`] : []),
            '</details>',
          ].join('\n'),
        ];
  const [exploreHead = [], ...exploreRest] = explore === undefined ? [] : exploreSections(run, explore, options);
  const sections = [exploreHead, errors, table, ...exploreRest, passedBlock].filter((section) => section.length > 0);

  const head = [...(options.marker === undefined ? [] : [options.marker]), explore === undefined ? headline(run, groups) : exploreHeadline(run, explore), ''];
  const tail = footer(run, options);
  const render = (body: readonly string[]): string => `${[...head, ...body, ...tail].join('\n')}\n`;

  // Greedy fit: keep whole parts in order while they fit, then say what was cut.
  let size = render([TRUNCATED_NOTE]).length;
  const body: string[] = [];
  let cut = false;
  for (const section of sections) {
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
