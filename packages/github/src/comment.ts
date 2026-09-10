/**
 * The report-1 document as one pull request comment: a headline with the
 * counts, the run-level errors, a table of every test that did not simply
 * pass, the passed tests folded away, and where the evidence is.
 *
 * Everything a test wrote (titles, error messages) is untrusted text on its
 * way into markdown GitHub renders, so cells are escaped and clipped. The
 * builder is exported so a hosted run page can render the same comment.
 */

import { stripVTControlCharacters } from 'node:util';
import type { Report } from '@e2edev/e2e';

type ReportRun = Report['run'];
type ReportResult = ReportRun['results'][number];
type ReportSerialGroup = ReportRun['serialGroups'][number];
type ReportError = ReportRun['errors'][number];
type ArtifactKind = ReportResult['attempts'][number]['artifacts'][number]['kind'];

export interface CommentOptions {
  /** A hidden HTML comment the reporter finds its own comment by; left out of a job summary. */
  readonly marker?: string;
  /** Where the run's artifacts can be fetched: the workflow run page, or a hosted run page. */
  readonly artifactsUrl?: string;
  /** A link to a source line, when the commit is known. */
  readonly sourceUrl?: (file: string, line: number) => string;
}

/** GitHub rejects a comment body past 65536 characters; stay clear of it. */
const MAX_BODY_CHARS = 60_000;
const MAX_TABLE_ROWS = 50;
const MAX_RUN_ERRORS = 20;
const MAX_FOOTER_TARGETS = 8;
const TRUNCATED_NOTE = '_Comment truncated to fit GitHub\'s size limit; the full report is in the run artifacts._';
const MAX_PASSED_LINES = 200;
const MAX_CELL_CHARS = 240;

/** C0/C1 control characters except tab and newline; ANSI sequences are stripped first. */
// oxlint-disable-next-line no-control-regex -- the control range is the point
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** One line of plain text: no color codes, no control characters, no line breaks. */
function plain(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

/**
 * Text safe inside a table cell: markdown that could open a construct is
 * escaped, angle brackets become entities so no HTML gets through, and the
 * cell separator is escaped. An underscore stays: inside a word GitHub
 * never reads it as emphasis, and error codes are full of them.
 */
function cell(text: string, max = MAX_CELL_CHARS): string {
  return clip(plain(text), max)
    .replace(/[\\`*[\]~|]/g, (char) => `\\${char}`)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
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
 * What one result's final attempt left behind, wherever the report keeps it.
 * The evidence is the union over every attempt: a flaky test's failure
 * screenshot belongs to the attempt that failed, not to the one that passed.
 */
interface FinalAttempt {
  readonly durationMs: number;
  readonly error: ReportError | undefined;
  readonly attempts: number;
  readonly artifactKinds: readonly ArtifactKind[];
}

/**
 * A serial member's result has no attempts of its own: its error and duration
 * live on the group's final attempt, keyed by test id. Every other result
 * answers from its own final attempt.
 */
function finalAttempt(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): FinalAttempt {
  if (result.serialGroupId === undefined) {
    const last = result.attempts.at(-1);
    return {
      durationMs: last?.durationMs ?? 0,
      error: last?.error,
      attempts: result.attempts.length,
      artifactKinds: kinds(result.attempts.flatMap((attempt) => attempt.artifacts)),
    };
  }
  const group = groups.get(result.serialGroupId);
  const last = group?.attempts.at(-1);
  const member = last?.members.find((candidate) => candidate.testId === result.testId);
  return {
    durationMs: member?.durationMs ?? 0,
    error: member?.error ?? last?.error,
    attempts: group?.attempts.length ?? 0,
    artifactKinds: kinds((group?.attempts ?? []).flatMap((attempt) => attempt.artifacts)),
  };
}

const KIND_ORDER: readonly ArtifactKind[] = ['screenshot', 'video', 'trace', 'download', 'log'];

function kinds(artifacts: readonly { readonly kind: ArtifactKind }[]): ArtifactKind[] {
  const present = new Set(artifacts.map((artifact) => artifact.kind));
  return KIND_ORDER.filter((kind) => present.has(kind));
}

type Bucket = 'failed' | 'flaky' | 'skipped' | 'passed';

/** Failed first, then flaky, then skipped; passed tests fold away. */
const BUCKETS: readonly Bucket[] = ['failed', 'flaky', 'skipped', 'passed'];

function bucket(status: ReportResult['status']): Bucket {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

const ICON: Record<Bucket, string> = { failed: '🔴', flaky: '⚠️', skipped: '⏭️', passed: '🟢' };

function headline(run: ReportRun, counts: Record<Bucket, number>): string {
  const parts = (['failed', 'flaky', 'passed', 'skipped'] as const)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`);
  const summary =
    parts.length > 0 ? parts.join(', ') : run.errors.length > 0 ? 'no tests ran' : 'no tests selected';
  const icon = run.status === 'passed' ? ICON.passed : ICON.failed;
  return `### ${icon} e2e: ${summary}`;
}

function errorText(error: ReportError): string {
  const phase = error.phase === undefined ? '' : ` (${plain(error.phase)})`;
  return `**${cell(error.code, 128)}**${phase} ${cell(error.message)}`.trim();
}

function title(result: ReportResult): string {
  return result.titlePath.map((part) => cell(part, 120)).join(' › ');
}

function testCell(result: ReportResult, options: CommentOptions, manyTargets: boolean): string {
  const location = `${result.source.file}:${result.source.line}`;
  const link =
    options.sourceUrl === undefined
      ? `\`${plain(location).replaceAll('`', '')}\``
      : `[${cell(location)}](${options.sourceUrl(result.source.file, result.source.line)})`;
  const target = manyTargets ? ` (${cell(result.targetId, 64)})` : '';
  return `${link} › ${title(result)}${target}`;
}

function outcomeCell(result: ReportResult, final: FinalAttempt): string {
  switch (bucket(result.status)) {
    case 'flaky': {
      const failed = final.attempts - 1;
      return `flaky: passed on attempt ${final.attempts} after ${plural(failed, 'failed attempt')}`;
    }
    case 'skipped':
      return `skipped: ${cell(result.skip?.reason ?? 'skipped')}`;
    default:
      return final.error === undefined ? cell(result.status) : errorText(final.error);
  }
}

function evidenceCell(final: FinalAttempt, options: CommentOptions): string {
  if (final.artifactKinds.length === 0) return '';
  const text = final.artifactKinds.join(', ');
  return options.artifactsUrl === undefined ? text : `[${text}](${options.artifactsUrl})`;
}

function table(rows: readonly string[][], omitted: number): string[] {
  if (rows.length === 0) return [];
  const lines = ['| | Test | Outcome | Evidence |', '| --- | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  if (omitted > 0) lines.push(`| | and ${omitted} more | | |`);
  return lines;
}

function passedSection(
  passed: readonly { result: ReportResult; final: FinalAttempt }[],
  manyTargets: boolean,
): string[] {
  if (passed.length === 0) return [];
  const shown = passed.slice(0, MAX_PASSED_LINES);
  const lines = ['<details>', `<summary>${plural(passed.length, 'passed test')}</summary>`, ''];
  for (const { result, final } of shown) {
    const target = manyTargets ? ` (${cell(result.targetId, 64)})` : '';
    lines.push(`- ${cell(result.file, 200)} › ${title(result)}${target} (${formatDuration(final.durationMs)})`);
  }
  if (passed.length > shown.length) lines.push(`- and ${passed.length - shown.length} more`);
  lines.push('</details>');
  return lines;
}

function footer(run: ReportRun, options: CommentOptions): string[] {
  const duration = formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const lines: string[] = [];
  if (options.artifactsUrl !== undefined) {
    lines.push(`Screenshots, traces, and recordings: [run artifacts](${options.artifactsUrl}).`);
  }
  const shown = run.targets.slice(0, MAX_FOOTER_TARGETS).map((target) => cell(target.id, 64));
  if (run.targets.length > shown.length) shown.push(`and ${run.targets.length - shown.length} more`);
  const targets = shown.join(', ');
  lines.push(
    `<sub>e2e ${cell(run.runner.version, 64)} · ${duration} · ${plural(run.targets.length, 'target')}${targets === '' ? '' : ` (${targets})`}</sub>`,
  );
  return lines;
}

/** Renders the run as a pull request comment body. */
export function renderComment(report: Report, options: CommentOptions = {}): string {
  const run = report.run;
  const groups = new Map(run.serialGroups.map((group) => [group.id, group]));
  const manyTargets = run.targets.length > 1;
  const counts: Record<Bucket, number> = { failed: 0, flaky: 0, skipped: 0, passed: 0 };
  const rows: string[][] = [];
  const passed: { result: ReportResult; final: FinalAttempt }[] = [];

  for (const kind of BUCKETS) {
    for (const result of run.results) {
      if (bucket(result.status) !== kind) continue;
      counts[kind] += 1;
      const final = finalAttempt(result, groups);
      if (kind === 'passed') {
        passed.push({ result, final });
        continue;
      }
      rows.push([
        ICON[kind],
        testCell(result, options, manyTargets),
        outcomeCell(result, final),
        evidenceCell(final, options),
      ]);
    }
  }

  const head: string[] = [];
  if (options.marker !== undefined) head.push(options.marker);
  head.push(headline(run, counts), '');
  const tail = footer(run, options);

  const build = (withPassed: boolean): string[] => {
    const lines: string[] = [];
    const errors = run.errors.slice(0, MAX_RUN_ERRORS);
    for (const error of errors) lines.push(`> ${errorText(error)}`);
    if (run.errors.length > errors.length) lines.push(`> and ${run.errors.length - errors.length} more`);
    if (errors.length > 0) lines.push('');
    const shown = rows.slice(0, MAX_TABLE_ROWS);
    lines.push(...table(shown, rows.length - shown.length));
    if (shown.length > 0) lines.push('');
    if (withPassed) {
      const section = passedSection(passed, manyTargets);
      if (section.length > 0) lines.push(...section, '');
    }
    return lines;
  };
  const join = (body: readonly string[]): string => `${[...head, ...body, ...tail].join('\n')}\n`;

  const full = join(build(true));
  if (full.length <= MAX_BODY_CHARS) return full;
  const withoutPassed = build(false);
  if (join(withoutPassed).length <= MAX_BODY_CHARS) return join(withoutPassed);
  // Still too long: drop body lines from the end until it fits, and say so.
  const body = [...withoutPassed];
  while (body.length > 0 && join([...body, TRUNCATED_NOTE]).length > MAX_BODY_CHARS) body.pop();
  const truncated = join([...body, TRUNCATED_NOTE]);
  // The head and footer are bounded by the caps above; a caller's own marker is
  // not, so the last resort is a cut at the limit rather than a rejected post.
  return truncated.length <= MAX_BODY_CHARS ? truncated : `${truncated.slice(0, MAX_BODY_CHARS - 1)}…`;
}
