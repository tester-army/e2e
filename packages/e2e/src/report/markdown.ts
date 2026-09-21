/**
 * The report-1 document as one markdown page, laid out for a pull request:
 * a headline with the counts and what the run spent, the run-level errors,
 * one block per test that failed with the step it went wrong at and the
 * agent's last word, the flaky tests folded away with the same block each,
 * and every test folded away under that, grouped by file with the file's
 * counts and time. A green run is the headline, the folds, and the footer:
 * nothing to read unless the reader opens it. An `e2e explore` run
 * renders its record instead: the goal, every finding with its evidence,
 * and the assessment. The built-in `markdown` reporter writes the page as
 * `summary.md` beside `report.json`; `@e2edev/github` posts it as the pull
 * request comment.
 *
 * Everything a test or the agent wrote (titles, labels, error messages,
 * findings) is untrusted text on its way into markdown a renderer trusts,
 * so it is escaped and clipped, and the whole body never outgrows what
 * GitHub accepts.
 */

import path from 'node:path';
import { collapseText } from '../internal/text.ts';
import type { Report1Document, ReportError, ReportExplore, ReportExploreFinding, ReportResult, ReportStep } from './build.ts';
import { ENDED_TEXT, orderFindings, SEVERITY_WORDS, stepCountParts } from './explore-text.ts';
import { formatCost, formatTokens, repeatSuffix, statusBucket, tally, type Counters } from './format.ts';
import {
  attemptsLine,
  detailLines,
  evidenceOf,
  failedStepOf,
  type FailedStep,
  failureSource,
  lastTurnLines,
  MAX_DETAIL_CHARS,
  renderFailurePage,
  screenLines,
  sourceText,
  stepLabel,
  toldAttempt,
} from './failure-text.ts';
import { cell, code, formatDuration, link, MAX_ID_CHARS, MAX_PATH_CHARS, MAX_TITLE_CHARS, plural } from './markdown-text.ts';
import { outcome, type Outcome } from './outcome.ts';
import { sanitizePathSegment } from '../run/artifacts.ts';
import { toPosixPath, writeTextReport } from './write.ts';
import type { Reporter, ReporterSummary } from '../types.ts';
import { readFileSync, rmSync } from 'node:fs';

type ReportRun = Report1Document['run'];
type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];
type ArtifactKind = ReportArtifact['kind'];
type Bucket = ReturnType<typeof statusBucket>;

export interface MarkdownReportOptions {
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
  /**
   * Where each failed or flaky result's own page is, by result id, as the
   * reader should see the path; the block links there. The `markdown`
   * reporter writes the pages under `failures/` beside the report.
   */
  readonly failurePages?: ReadonlyMap<string, string> | undefined;
  /**
   * Tells this run's page apart from another's on the same pull request in
   * the headline: `e2e regression: 77 passed`. The GitHub reporter passes
   * its `key`.
   */
  readonly title?: string | undefined;
}

/**
 * GitHub rejects a comment body past 65536 characters. The page stays
 * clear of it with room for what a poster prepends (a marker comment).
 */
const MAX_BODY_CHARS = 60_000;
/** Reader caps, not size guards: past these the page says how many more there are. */
const MAX_FAILURE_BLOCKS = 30;
const MAX_RUN_ERRORS = 20;
const MAX_LISTED_TESTS = 400;
const MAX_FOOTER_TARGETS = 8;
const MAX_FINDINGS = 30;
const MAX_EVIDENCE_PATHS = 4;
const MAX_ASSESSMENT_CHARS = 2_000;
const MAX_GOAL_CHARS = 400;
const TRUNCATED_NOTE = '_Truncated to fit a pull request comment; the full report is in `report.json`._';

/** A result with what it left behind, read once. */
interface Entry {
  readonly result: ReportResult;
  readonly final: Outcome;
}

/** Screenshots first, then the recording, then the trace; the compiler fails when a kind is missing here. */
const KIND_RANK: Record<ArtifactKind, number> = { screenshot: 0, video: 1, trace: 2, download: 3, log: 4 };

const ICON: Record<Bucket, string> = { failed: '🔴', flaky: '⚠️', skipped: '⏭️', passed: '🟢' };
/** Worst first: the order failures are listed, files are sorted, and a file's glyph is chosen in. */
const WORST_FIRST: readonly Bucket[] = ['failed', 'flaky', 'skipped', 'passed'];
/** The order counts read in: `1 failed, 1 flaky, 3 passed, 1 skipped`. */
const COUNT_ORDER: readonly Bucket[] = ['failed', 'flaky', 'passed', 'skipped'];

function worstBucket(results: readonly ReportResult[]): Bucket {
  const present = new Set(results.map((result) => statusBucket(result.status)));
  return WORST_FIRST.find((key) => present.has(key)) ?? 'passed';
}

/** `1 failed, 3 passed`, zero counts left out. */
function countText(counts: Counters): string {
  return COUNT_ORDER.filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(', ');
}

/** `e2e regression`, or `e2e` when the page has no title. */
function pageName(options: MarkdownReportOptions): string {
  const title = options.title?.trim() ?? '';
  return title === '' ? 'e2e' : `e2e ${cell(title, MAX_ID_CHARS)}`;
}

function headline(run: ReportRun, options: MarkdownReportOptions): string {
  const summary = countText(tally(run.results)) || (run.errors.length > 0 ? 'no tests ran' : 'no tests selected');
  return `### ${run.status === 'passed' ? ICON.passed : ICON.failed} ${pageName(options)}: ${summary}`;
}

/** The model calls an agent step made; the step's metrics are the source of truth. */
function modelCalls(step: ReportStep): number {
  return step.metrics?.modelCalls ?? 0;
}

/** What the agent did over a set of steps. */
function agentTotals(steps: readonly ReportStep[]): { steps: number; replayed: number; calls: number } {
  const agent = steps.filter((step) => step.kind === 'agent');
  return {
    steps: agent.length,
    replayed: agent.filter((step) => step.cache?.mode === 'self-finalized').length,
    calls: agent.reduce((total, step) => total + modelCalls(step), 0),
  };
}

/**
 * `41 agent steps · 12 replayed from cache · 128.4k tokens (62% cached) · $0.31`,
 * under the headline of a run that used the agent; a deterministic run has
 * nothing to say here.
 */
function spendLine(run: ReportRun, entries: readonly Entry[]): string | undefined {
  const totals = agentTotals(entries.flatMap((entry) => entry.final.final.steps));
  if (totals.steps === 0 && run.usage.modelTokens === 0) return undefined;
  const parts = [plural(totals.steps, 'agent step')];
  if (totals.replayed > 0) parts.push(`${totals.replayed} replayed from cache`);
  if (totals.calls > 0) parts.push(plural(totals.calls, 'model call'));
  if (run.usage.modelTokens > 0) {
    const cached = run.usage.modelCachedTokens ?? 0;
    const share = cached === 0 ? '' : ` (${Math.round((cached / run.usage.modelTokens) * 100)}% cached)`;
    parts.push(`${formatTokens(run.usage.modelTokens)} tokens${share}`);
  }
  if (run.usage.estimatedCostUsd !== undefined) parts.push(formatCost(run.usage.estimatedCostUsd));
  return parts.join(' · ');
}

/**
 * Where the evidence is: linked to the run page when there is one, listed as
 * paths under `artifactsDir` when the reader has the files, and named by
 * kind otherwise. Paths are POSIX, as the report keeps them.
 */
function evidence(artifacts: readonly ReportArtifact[], options: MarkdownReportOptions): string {
  if (artifacts.length === 0) return '';
  const sorted = artifacts.toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const named = [...new Set(sorted.map((artifact) => artifact.kind))].join(', ');
  if (options.artifactsUrl !== undefined) return link(named, options.artifactsUrl);
  const dir = options.artifactsDir;
  const files = dir === undefined ? [] : sorted.flatMap((artifact) => (artifact.path === undefined ? [] : [{ kind: artifact.kind, file: path.posix.join(dir, artifact.path) }]));
  if (files.length === 0) return named;
  const shown = files.slice(0, MAX_EVIDENCE_PATHS).map(({ kind, file }) => `${kind} ${code(file)}`);
  if (files.length > shown.length) shown.push(`and ${files.length - shown.length} more`);
  return shown.join(', ');
}

// --- a test that did not pass ---

/**
 * `at step 6 of 6: \`expect.toBeHidden\` \`getByRole(...)\`, after 15.1s and 12
 * model calls`: where a failure happened, how long the step ran, and what
 * the agent spent on it.
 */
function stepClause(steps: readonly ReportStep[], at: { index: number; step: FailedStep }): string {
  const calls = modelCalls(at.step);
  const spent = calls === 0 ? '' : ` and ${plural(calls, 'model call')}`;
  return `at step ${at.index + 1} of ${steps.length}: ${code(at.step.api, MAX_ID_CHARS)} ${stepLabel(at.step, MAX_PATH_CHARS)}, after ${formatDuration(at.step.durationMs)}${spent}`;
}

/** `**CODE** (phase)`: how the error names itself. */
function errorName(error: ReportError): string {
  const phase = error.phase === undefined || error.phase === 'body' ? '' : ` (${collapseText(error.phase)})`;
  return `**${cell(error.code, 128)}**${phase}`;
}

/**
 * What the error and the agent said, for the quote under the lead. An
 * assertion's message restates the facts the list carries, so only its
 * first line is quoted, and not when that line just says the api failed. An
 * agent step's explanation is quoted once: skipped when the message already
 * is the explanation.
 */
function quotedWords(error: ReportError | undefined, at: FailedStep | undefined): string[] {
  const words: string[] = [];
  if (error !== undefined) {
    const first = error.message.split('\n')[0] ?? '';
    const message = detailLines(error).length > 0 ? first : error.message;
    if (message.trim() !== '' && !(at !== undefined && first === `${at.api} failed`)) words.push(message);
  }
  const said = at?.explanation?.trim() ?? '';
  if (said !== '' && !words.some((word) => word.includes(said))) words.push(said);
  return words.map((word) => `> ${cell(word, MAX_DETAIL_CHARS)}`);
}

/** A run-level error in one quoted line: name, message, facts. */
function runErrorLine(error: ReportError): string {
  const facts = detailLines(error);
  const message = facts.length > 0 ? (error.message.split('\n')[0] ?? '') : error.message;
  return `> ${[`${errorName(error)} ${cell(message)}`.trim(), ...facts].join(' · ')}`;
}

/**
 * One block per test that failed or was flaky, in paragraphs the eye can
 * rest between: the title; one lead sentence naming the error and the step
 * it happened at; what the error and the agent said, quoted; the facts as a
 * list (expected and observed, whether every attempt failed alike, the last
 * turns, the screen); and the line to look at with the evidence. The file
 * is named once, in the source link. The steps before the failed one are
 * not retold: the lead says where in the flow it was, and the trace has the
 * rest. A flaky test's story is its last failed attempt, not the retry that
 * passed.
 */
function failureBlock({ result, final }: Entry, manyTargets: boolean, options: MarkdownReportOptions): string {
  const kind = statusBucket(result.status);
  const told = toldAttempt(result, final);
  const at = failedStepOf(told.steps);
  const error = told.error;
  const name = error === undefined ? `**${cell(result.status, MAX_ID_CHARS)}**` : errorName(error);
  const lead = at === undefined ? name : `${name} ${stepClause(told.steps, at)}`;
  const alike = attemptsLine(result, final);
  const facts = [...detailLines(error), ...(alike === undefined ? [] : [alike]), ...lastTurnLines(at?.step), ...screenLines(told)];
  const where = evidence(evidenceOf(told), options);
  const page = options.failurePages?.get(result.id);
  const tail = [
    sourceText(failureSource(result, told), options.sourceUrl),
    ...(where === '' ? [] : [`Evidence: ${where}`]),
    ...(page === undefined ? [] : [`Details: ${code(page, MAX_PATH_CHARS)}`]),
  ];
  const paragraphs = [
    `**${ICON[kind]} ${testName(result, manyTargets)}**`,
    lead,
    quotedWords(error, at?.step).join('\n'),
    facts.map((fact) => `- ${fact}`).join('\n'),
    tail.join(' · '),
  ];
  return paragraphs.filter((paragraph) => paragraph !== '').join('\n\n');
}

/** `file (target)`, the target named only when the run has several. */
function fileLabel(file: string, target: string, manyTargets: boolean): string {
  return `${cell(file, MAX_PATH_CHARS)}${manyTargets ? ` (${cell(target, MAX_ID_CHARS)})` : ''}`;
}

/** `suite › title (target)`. */
function testName(result: ReportResult, manyTargets: boolean): string {
  const title = result.titlePath.map((part) => cell(part, MAX_TITLE_CHARS)).join(' › ');
  return `${title}${repeatSuffix(result.repeat)}${manyTargets ? ` (${cell(result.targetId, MAX_ID_CHARS)})` : ''}`;
}

/**
 * The tests that were flaky, folded: the headline counts them and the run is
 * green, so their blocks are there for the reader who asks, not in the way.
 */
function flakyFold(entries: readonly Entry[], manyTargets: boolean, options: MarkdownReportOptions): string[] {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, MAX_FAILURE_BLOCKS).map((entry) => failureBlock(entry, manyTargets, options));
  if (entries.length > shown.length) shown.push(`and ${entries.length - shown.length} more`);
  const summary = `${ICON.flaky} ${plural(entries.length, 'flaky test')} passed on a retry`;
  return [['<details>', `<summary>${summary}</summary>`, '', shown.join('\n\n'), '</details>'].join('\n')];
}

// --- every test, by file ---

interface FileGroup {
  readonly file: string;
  readonly target: string;
  readonly entries: readonly Entry[];
}

/** Results grouped by file and target, the worst file first, then by path. */
function fileGroups(entries: readonly Entry[]): FileGroup[] {
  const groups = new Map<string, Map<string, Entry[]>>();
  for (const entry of entries) {
    const byFile = groups.get(entry.result.targetId) ?? new Map<string, Entry[]>();
    byFile.set(entry.result.file, [...(byFile.get(entry.result.file) ?? []), entry]);
    groups.set(entry.result.targetId, byFile);
  }
  const rows = [...groups].flatMap(([target, byFile]) => [...byFile].map(([file, grouped]) => ({ file, target, entries: grouped })));
  const rank = (group: FileGroup): number => WORST_FIRST.indexOf(worstBucket(group.entries.map((entry) => entry.result)));
  return rows.toSorted((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.target.localeCompare(b.target));
}

/** One line of the folded list: glyph, name, and how the test ended. */
function listedTest({ result, final }: Entry, manyTargets: boolean): string {
  const note =
    result.status === 'skipped'
      ? `skipped: ${cell(result.skip?.reason ?? 'skipped')}`
      : result.status === 'flaky'
        ? `${formatDuration(final.durationMs)}, ${plural(final.failedAttempts, 'failed attempt')} first`
        : formatDuration(final.durationMs);
  return `- ${ICON[statusBucket(result.status)]} ${testName(result, manyTargets)} (${note})`;
}

/** `**tests/billing.e2e.ts** · 1 failed, 2 passed · 3 steps · 19 calls · 41.2s`: a file's line in the folded list. */
function fileHeading(group: FileGroup, manyTargets: boolean): string {
  const results = group.entries.map((entry) => entry.result);
  const totals = agentTotals(group.entries.flatMap((entry) => entry.final.final.steps));
  const parts = [`**${fileLabel(group.file, group.target, manyTargets)}**`, countText(tally(results))];
  if (totals.steps > 0) parts.push(plural(totals.steps, 'step'));
  if (totals.calls > 0) parts.push(plural(totals.calls, 'call'));
  parts.push(formatDuration(group.entries.reduce((total, entry) => total + entry.final.durationMs, 0)));
  return parts.join(' · ');
}

/** Every test, grouped by file worst first, each file with its counts and time, folded away; one block since a `<details>` cannot be cut halfway. */
function allTests(groups: readonly FileGroup[], total: number, manyTargets: boolean): string[] {
  if (total === 0) return [];
  let budget = MAX_LISTED_TESTS;
  const blocks: string[] = [];
  for (const group of groups) {
    if (budget === 0) break;
    const shown = group.entries.slice(0, budget);
    budget -= shown.length;
    blocks.push([fileHeading(group, manyTargets), ...shown.map((entry) => listedTest(entry, manyTargets))].join('\n'));
  }
  if (total > MAX_LISTED_TESTS) blocks.push(`- and ${total - MAX_LISTED_TESTS} more`);
  // A file that ran on several targets is one file, however many groups it has.
  const files = new Set(groups.map((group) => group.file)).size;
  const summary = `All ${plural(total, 'test')} in ${plural(files, 'file')}`;
  return [['<details>', `<summary>${summary}</summary>`, '', blocks.join('\n\n'), '</details>'].join('\n')];
}

/** `<sub>e2e 0.13.0 · 2m 15s · web · run artifacts</sub>`: one line of small print. */
function footer(run: ReportRun, options: MarkdownReportOptions): string[] {
  const duration = formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const shown = run.targets.slice(0, MAX_FOOTER_TARGETS).map((target) => cell(target.id, MAX_ID_CHARS));
  if (run.targets.length > shown.length) shown.push(`and ${run.targets.length - shown.length} more`);
  const parts = [`e2e ${cell(run.runner.version, MAX_ID_CHARS)}`, duration];
  if (run.targets.length === 1) parts.push(shown[0] ?? '');
  else if (run.targets.length > 1) parts.push(`${plural(run.targets.length, 'target')} (${shown.join(', ')})`);
  if (options.artifactsUrl !== undefined) parts.push(link('run artifacts', options.artifactsUrl));
  return [`<sub>${parts.join(' · ')}</sub>`];
}

// --- the exploration record ---

function exploreHeadline(run: ReportRun, explore: ReportExplore, options: MarkdownReportOptions): string {
  const issues = explore.findings.filter((finding) => finding.kind === 'issue').length;
  const warnings = explore.findings.length - issues;
  const counts = [...(issues > 0 ? [plural(issues, 'issue')] : []), ...(warnings > 0 ? [plural(warnings, 'warning')] : [])];
  const summary =
    counts.length > 0 ? counts.join(', ') : run.status === 'blocked' ? 'explored nothing' : run.status === 'passed' ? 'no findings' : 'did not finish';
  return `### ${run.status === 'passed' ? ICON.passed : ICON.failed} ${pageName(options)} explore: ${summary}`;
}

/** `3 of 8 steps · 2 passed · 1 failed · the agent covered the goal`. */
function exploreSteps(explore: ReportExplore): string {
  const counts = stepCountParts(explore.steps).map((part) => part.text);
  return [`${explore.steps.length} of ${explore.budgets.maxSteps} steps`, ...counts, ENDED_TEXT[explore.ended]].join(' · ');
}

/**
 * One finding as a list item: grade and title, where it was seen, what was
 * expected against what the screen showed, the actions that reach it, and
 * its screenshot.
 */
function findingBlock(finding: ReportExploreFinding, position: number, artifacts: ReadonlyMap<string, ReportArtifact>, options: MarkdownReportOptions): string {
  const where = [...(finding.path === undefined ? [] : [code(finding.path, MAX_TITLE_CHARS)]), ...(finding.step === undefined ? [] : [`step ${finding.step}`])];
  const lines = [
    `${position}. **${SEVERITY_WORDS[finding.severity]} ${finding.kind}** ${cell(finding.title)}${where.length === 0 ? '' : ` · ${where.join(' · ')}`}`,
    `   Expected: ${cell(finding.expected, MAX_DETAIL_CHARS)}`,
    `   Actual: ${cell(finding.actual, MAX_DETAIL_CHARS)}`,
  ];
  if (finding.reproduction.length > 0) {
    lines.push(`   Steps: ${finding.reproduction.map((action, index) => `${index + 1}. ${cell(action, MAX_PATH_CHARS)}`).join(' ')}`);
  }
  const screenshot = finding.artifactId === undefined ? undefined : artifacts.get(finding.artifactId);
  if (screenshot !== undefined) lines.push(`   Evidence: ${evidence([screenshot], options)}`);
  return lines.join('  \n');
}

/** The findings, issues before warnings and the most severe first, capped. */
function findingsSection(run: ReportRun, explore: ReportExplore, options: MarkdownReportOptions): string[] {
  if (explore.findings.length === 0) return [];
  const artifacts = new Map(run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.artifacts)).map((artifact) => [artifact.id, artifact]));
  const ordered = orderFindings(explore.findings);
  const blocks = ordered.slice(0, MAX_FINDINGS).map((finding, index) => findingBlock(finding, index + 1, artifacts, options));
  if (ordered.length > blocks.length) blocks.push(`${blocks.length + 1}. and ${ordered.length - blocks.length} more`);
  return ['**Findings**', '', ...blocks];
}

/**
 * Whether a result's failure is the exploration's verdict, which the findings
 * already express; only a failure that is not gets a block of its own.
 */
function isVerdict(entry: Entry, explore: ReportExplore): boolean {
  return entry.final.final.error?.code === 'ASSERTION_FAILED' && explore.findings.some((finding) => finding.kind === 'issue');
}

/**
 * Greedy fit: keeps whole parts in order while they fit under the budget,
 * then says what was cut. `parts` are lines or indivisible blocks, already
 * separated by blank lines.
 */
function fit(head: readonly string[], parts: readonly string[], tail: readonly string[]): string {
  const render = (body: readonly string[]): string => `${[...head, ...body, ...tail].join('\n')}\n`;
  let size = render([TRUNCATED_NOTE]).length;
  const kept: string[] = [];
  for (const part of parts) {
    if (size + part.length + 1 > MAX_BODY_CHARS) return render([...kept, TRUNCATED_NOTE]);
    kept.push(part);
    size += part.length + 1;
  }
  return render(kept);
}

/** Sections as one flat list of parts with a blank line between sections; empty sections vanish. */
function joinSections(sections: readonly (readonly string[])[]): string[] {
  return sections.filter((section) => section.length > 0).flatMap((section, index) => (index === 0 ? [...section] : ['', ...section]));
}

/** Renders the run as one markdown page: a pull request comment body, a job summary, or `summary.md`. */
export function renderMarkdownReport(report: Report1Document, options: MarkdownReportOptions = {}): string {
  const run = report.run;
  const explore = run.explore;
  const serialGroups = new Map(run.serialGroups.map((group) => [group.id, group]));
  const entries: Entry[] = run.results.map((result) => ({ result, final: outcome(result, serialGroups) }));
  const manyTargets = run.targets.length > 1;

  const errors = run.errors.slice(0, MAX_RUN_ERRORS).map(runErrorLine);
  if (run.errors.length > errors.length) errors.push(`> and ${run.errors.length - errors.length} more`);
  // An exploration is the run's one test and its failure is the verdict the
  // findings express, so that block gives way to them; any other failure stays.
  const notPassed = entries.filter((entry) => explore === undefined || !isVerdict(entry, explore));
  const failed = notPassed.filter(({ result }) => statusBucket(result.status) === 'failed');
  const failures = failed.slice(0, MAX_FAILURE_BLOCKS).map((entry) => [failureBlock(entry, manyTargets, options)]);
  if (failed.length > failures.length) failures.push([`and ${failed.length - failures.length} more failed`]);
  const flaky = flakyFold(
    notPassed.filter(({ result }) => statusBucket(result.status) === 'flaky'),
    manyTargets,
    options,
  );

  const spend = spendLine(run, entries);
  const head = [explore === undefined ? headline(run, options) : exploreHeadline(run, explore, options), ...(spend === undefined ? [] : [spend]), ''];
  const groups = fileGroups(entries);
  const sections =
    explore === undefined
      ? [errors, ...failures, flaky, allTests(groups, run.results.length, manyTargets)]
      : [
          [`**Goal:** ${cell(explore.goal, MAX_GOAL_CHARS)}  `, `**Steps:** ${exploreSteps(explore)}`],
          errors,
          ...failures,
          flaky,
          findingsSection(run, explore, options),
          explore.summary === undefined ? [] : ['**Assessment**', '', cell(explore.summary, MAX_ASSESSMENT_CHARS)],
        ];
  const body = joinSections(sections);
  return fit(head, body.length === 0 ? [] : [...body, ''], footer(run, options));
}

/** Where a result's page goes under `failures/`: the file and title, made a path segment, made unique by the result id. */
function failurePageName(result: ReportResult): string {
  return `${sanitizePathSegment(`${result.file}-${result.titlePath.join('-')}`)}-${result.id.slice(0, 8)}.md`;
}

/**
 * The results that get a page: every one that failed, timed out, was
 * interrupted, or was flaky, except an exploration's own verdict, which its
 * findings already tell.
 */
function pagedResults(report: Report1Document): ReportResult[] {
  const explore = report.run.explore;
  const serialGroups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  return report.run.results.filter((result) => {
    const bucket = statusBucket(result.status);
    if (bucket !== 'failed' && bucket !== 'flaky') return false;
    return explore === undefined || !isVerdict({ result, final: outcome(result, serialGroups) }, explore);
  });
}

/**
 * The built-in `markdown` reporter: the report as one markdown page in
 * `summary.md` beside `report.json`, with evidence listed as paths from the
 * project root, for a reader with the checkout in front of it: a pull
 * request description, a coding agent's handoff, a wiki page. Every test
 * that did not pass gets a page of its own under `failures/`, with the
 * screen at failure inline; the run page links each block to its page. The
 * directory is the reporter's: what an earlier run left there is removed
 * first, so a stale page never describes a failure this run did not have.
 */
export const markdownReporter: Reporter = {
  name: 'markdown',
  async onRunFinished(run) {
    if (run.reportPath === undefined) return;
    const reportDir = path.dirname(run.reportPath);
    const artifactsDir = toPosixPath(path.relative(run.projectRoot, run.artifactsRoot)) || '.';
    const failuresDir = path.join(reportDir, 'failures');
    rmSync(failuresDir, { recursive: true, force: true });
    const serialGroups = new Map(run.report.run.serialGroups.map((group) => [group.id, group]));
    const readArtifact = (reportPath: string): string | undefined => {
      try {
        return readFileSync(path.join(run.artifactsRoot, reportPath), 'utf8');
      } catch {
        return undefined;
      }
    };
    const pages = new Map<string, string>();
    for (const result of pagedResults(run.report)) {
      const file = path.join(failuresDir, failurePageName(result));
      const page = renderFailurePage(run.report, result, outcome(result, serialGroups), { artifactsDir, readArtifact });
      await writeTextReport(file, page);
      pages.set(result.id, toPosixPath(path.relative(run.projectRoot, file)));
    }
    const summary = path.join(reportDir, 'summary.md');
    await writeTextReport(summary, renderMarkdownReport(run.report, { artifactsDir, failurePages: pages }));
    const rows: ReporterSummary = [
      { label: 'Markdown', text: path.relative(run.projectRoot, summary) || summary },
      ...(pages.size === 0 ? [] : [{ label: 'Failures', text: `${path.relative(run.projectRoot, failuresDir) || failuresDir}/ (${plural(pages.size, 'page')})` }]),
    ];
    return rows;
  },
};
