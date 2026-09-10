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
  readonly marker?: string | undefined;
  /** Where the run's artifacts can be fetched: the workflow run page, or a hosted run page. */
  readonly artifactsUrl?: string | undefined;
  /** A link to a source line, when the commit is known. */
  readonly sourceUrl?: ((file: string, line: number) => string) | undefined;
}

/** GitHub rejects a comment body past 65536 characters; stay clear of it. */
const MAX_BODY_CHARS = 60_000;
/** Reader caps, not size guards: past these the comment says how many more there are. */
const MAX_TABLE_ROWS = 50;
const MAX_RUN_ERRORS = 20;
const MAX_PASSED_LINES = 200;
const MAX_FOOTER_TARGETS = 8;
const MAX_CELL_CHARS = 240;
const TRUNCATED_NOTE = "_Comment truncated to fit GitHub's size limit; the full report is in the run artifacts._";
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
  readonly artifactKinds: readonly ArtifactKind[];
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
    artifactKinds: kinds(attempts.flatMap((attempt) => attempt.artifacts)),
  };
}

/** Screenshots first, then the recording, then the trace; the compiler fails when a kind is missing here. */
const KIND_RANK: Record<ArtifactKind, number> = { screenshot: 0, video: 1, trace: 2, download: 3, log: 4 };

function kinds(artifacts: readonly { readonly kind: ArtifactKind }[]): ArtifactKind[] {
  return [...new Set(artifacts.map((artifact) => artifact.kind))].toSorted((a, b) => KIND_RANK[a] - KIND_RANK[b]);
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

function evidenceCell(final: Outcome, options: CommentOptions): string {
  if (final.artifactKinds.length === 0) return '';
  const text = final.artifactKinds.join(', ');
  return options.artifactsUrl === undefined ? text : `[${text}](${options.artifactsUrl})`;
}

function footer(run: ReportRun, options: CommentOptions): string[] {
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

/** Renders the run as a pull request comment body. */
export function renderComment(report: Report, options: CommentOptions = {}): string {
  if (options.marker !== undefined && options.marker.length > MAX_MARKER_CHARS) {
    throw new Error(`renderComment: marker must be at most ${MAX_MARKER_CHARS} characters, got ${options.marker.length}`);
  }
  if (options.artifactsUrl !== undefined && options.artifactsUrl.length > MAX_URL_CHARS) {
    throw new Error(`renderComment: artifactsUrl must be at most ${MAX_URL_CHARS} characters, got ${options.artifactsUrl.length}`);
  }
  const run = report.run;
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
    return options.sourceUrl === undefined
      ? `\`${plain(location).replaceAll('`', '')}\``
      : `[${cell(location)}](${options.sourceUrl(result.source.file, result.source.line)})`;
  };

  // Body parts in priority order; each is one line, except the passed list,
  // which is one block since a `<details>` cannot be cut halfway.
  const errors = run.errors.slice(0, MAX_RUN_ERRORS).map((error) => `> ${errorText(error)}`);
  if (run.errors.length > errors.length) errors.push(`> and ${run.errors.length - errors.length} more`);
  const listed = LISTED.flatMap((key) => groups.get(key) ?? []);
  const rows = listed.slice(0, MAX_TABLE_ROWS).map((result) => {
    const final = outcome(result, serialGroups);
    return `| ${ICON[bucket(result.status)]} | ${name(result, linked(result))} | ${outcomeCell(result, final)} | ${evidenceCell(final, options)} |`;
  });
  const table = rows.length === 0 ? [] : ['| | Test | Outcome | Evidence |', '| --- | --- | --- | --- |', ...rows];
  if (listed.length > rows.length) table.push(`| | and ${listed.length - rows.length} more | | |`);
  const passed = groups.get('passed') ?? [];
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
  const sections = [errors, table, passedBlock].filter((section) => section.length > 0);

  const head = [...(options.marker === undefined ? [] : [options.marker]), headline(run, groups), ''];
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
