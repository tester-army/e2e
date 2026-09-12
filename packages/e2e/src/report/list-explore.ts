/**
 * The list reporter's view of an `e2e explore` run, fed by its `explore`
 * events: the exploration steps by title as they finish, each finding the
 * moment it is reported, and at the end the record, a `Findings` section
 * with the evidence, and the assessment. An exploration is one synthetic
 * test whose failure is its verdict, so the view stands in for the file
 * block, the test line, and the `Failed Tests` entry that test would get.
 */

import path from 'node:path';
import type { ExploreBudgets, ExploreProgress, OpenedStep } from '../explore/progress.ts';
import type { SerializedError } from '../internal/errors.ts';
import { collapseText } from '../internal/text.ts';
import type { ReportExplore, ReportExploreFinding, ReportExploreStep } from '../report/build.ts';
import type { ArtifactRecord } from '../run/records.ts';
import { ENDED_TEXT, orderFindings, SEVERITY_WORDS, stepCountParts } from './explore-text.ts';
import type { StepEvent } from '../run/steps.ts';
import {
  bounded,
  ellipsize,
  F_CHECK,
  F_CROSS,
  F_POINTER,
  formatTime,
  padTitle,
  rule,
  terminalColumns,
  terminalRows,
  visibleWidth,
  type Colors,
} from './format.ts';
import type { ShownEvent } from './list-model.ts';
import { eventLine } from './list-steps.ts';
import { WIDTH_MARGIN } from './live-window.ts';
import { waitingRow } from './running-tree.ts';

/** A finding, in the live window and the CI log. */
const F_FINDING = '⚑';
const F_DOWN_RIGHT = '↳';
/** Indentation of the exploration's rows under its header. */
const ROW_INDENT = '   ';
/** Indentation of the detail under a running exploration in the live window. */
const LIVE_INDENT = '       ';
/** Most recent calls of the step in progress the live window shows. */
const MAX_EVENTS = 6;
/** Rows the live window spends around the exploration: blank lines and the margin above the prompt. */
const CHROME_ROWS = 6;
/** Rows reserved for the exploration from the first paint, so the summary below does not jump. */
const RESERVED_ROWS = 14;
/** The tool call a finding stands in for; its own event is not an action. */
const FINDING_TOOL_EVENT = 'tool:report_finding';
/** Width of the label gutter in a finding's block: four for the number, then `expected  `. */
const DETAIL_LABEL_WIDTH = 8;
const DETAIL_INDENT = '    ';

const STATUS_WORDS: Record<ReportExploreStep['status'], string> = {
  passed: '',
  failed: 'failed',
  blocked: 'blocked',
  exhausted: 'ended at its limit',
};

/** One finished exploration step with what the view counted while it ran. */
interface FinishedStep {
  readonly step: ReportExploreStep;
  readonly actions: number;
  readonly findings: number;
}

interface OpenStep {
  readonly step: OpenedStep;
  actions: number;
  readonly findings: ReportExploreFinding[];
}

export class ExploreView {
  private readonly goal: string;
  private readonly budgets: ExploreBudgets;
  private readonly startedMs: number;
  private readonly steps: FinishedStep[] = [];
  private readonly findings: ReportExploreFinding[] = [];
  private open: OpenStep | undefined;
  /** What the planner is deciding while no step is open: nothing, the next step, or the closing assessment. */
  private planning: 'step' | 'closing' | undefined;
  private ended: ReportExplore['ended'] | undefined;
  private summary: string | undefined;
  /** The exploration test's artifacts, once its result arrived: where a finding's screenshot is. */
  private artifacts: readonly ArtifactRecord[] = [];
  /** High-water mark of the live rows; the window pads up to it. */
  private reservedRows = RESERVED_ROWS;

  constructor(
    private readonly pc: Colors,
    started: { readonly goal: string; readonly budgets: ExploreBudgets },
    private readonly now: () => number = Date.now,
  ) {
    this.goal = started.goal;
    this.budgets = started.budgets;
    this.startedMs = now();
  }

  /** Applies one moment of the exploration. */
  progress(progress: ExploreProgress): void {
    switch (progress.phase) {
      case 'started':
        break;
      case 'planning':
        this.planning = progress.closing ? 'closing' : 'step';
        break;
      case 'step-started':
        this.planning = undefined;
        this.open = { step: progress.step, actions: 0, findings: [] };
        break;
      case 'step-finished': {
        const open = this.open;
        this.open = undefined;
        this.steps.push({ step: progress.step, actions: open?.actions ?? 0, findings: open?.findings.length ?? 0 });
        break;
      }
      case 'finding':
        this.findings.push(progress.finding);
        this.open?.findings.push(progress.finding);
        break;
      case 'finished':
        this.planning = undefined;
        this.ended = progress.ended;
        this.summary = progress.summary;
        break;
    }
  }

  /** The step that finished last, with what the view counted while it ran. */
  get lastStep(): FinishedStep | undefined {
    return this.steps.at(-1);
  }

  /** Counts one engine event of the step in progress as an action; the finding tool's own call is the finding. */
  action(event: StepEvent): void {
    if (this.open === undefined || event.kind !== 'engine' || event.name === FINDING_TOOL_EVENT) return;
    this.open.actions += 1;
  }

  /** The exploration test's result arrived: keep its artifacts, so findings can name their screenshots. */
  result(artifacts: readonly ArtifactRecord[]): void {
    this.artifacts = artifacts;
  }

  /**
   * Whether the exploration test's error is the verdict the findings already
   * express: issues were found, so the test failed. Anything else (a provider
   * failure, a run that explored nothing) is a failure worth its own entry.
   */
  isVerdict(error: SerializedError): boolean {
    return error.code === 'ASSERTION_FAILED' && this.issues.length > 0;
  }

  private get issues(): readonly ReportExploreFinding[] {
    return this.findings.filter((finding) => finding.kind === 'issue');
  }

  /**
   * ` ❯ |web| Exploring  <goal>`; the goal clipped to `maxWidth` when given.
   * Once over, the glyph is the verdict: a cross when issues were found or
   * the exploration never concluded, a check otherwise.
   */
  header(badge: string, verb: 'Exploring' | 'Explored', maxWidth?: number): string {
    const { pc } = this;
    const glyph =
      verb === 'Exploring'
        ? pc.yellow(F_POINTER)
        : this.ended === undefined || this.issues.length > 0
          ? pc.red(F_CROSS)
          : pc.green(F_CHECK);
    const head = ` ${pc.bold(glyph)} ${badge} ${pc.bold(verb)}  `;
    const goal = collapseText(this.goal);
    return `${head}${maxWidth === undefined ? bounded(goal) : ellipsize(goal, Math.max(24, maxWidth - visibleWidth(head)))}`;
  }

  /** One finished step: glyph, number, title, then duration, actions, findings, and a non-passed status; its explanation under it. */
  stepLines(finished: FinishedStep, indent = ROW_INDENT): string[] {
    const { pc } = this;
    const { step } = finished;
    const glyph = step.status === 'passed' ? pc.green(F_CHECK) : step.status === 'failed' ? pc.red(F_CROSS) : pc.yellow(F_CROSS);
    const tail = [
      formatTime(step.durationMs),
      ...(finished.actions > 0 ? [`${finished.actions} action${finished.actions === 1 ? '' : 's'}`] : []),
      ...(finished.findings > 0 ? [`${finished.findings} finding${finished.findings === 1 ? '' : 's'}`] : []),
    ].join(' · ');
    const status = STATUS_WORDS[step.status];
    const lines = [
      `${indent}${glyph} ${pc.dim(String(step.index))}  ${bounded(step.title)} ${pc.dim(tail)}${status === '' ? '' : ` ${pc.yellow(status)}`}`,
    ];
    // A step that did not pass explains itself; a passed step's summary is the planner's, not the reader's.
    if (step.status !== 'passed' && step.summary !== undefined) {
      const room = terminalColumns() - WIDTH_MARGIN - indent.length - 5;
      lines.push(`${indent}     ${pc.dim(ellipsize(collapseText(step.summary), Math.max(24, room)))}`);
    }
    return lines;
  }

  /** One finding on one line: `⚑ high issue  Title (/path)`. */
  findingLine(finding: ReportExploreFinding, indent = ROW_INDENT): string {
    const { pc } = this;
    const location = finding.path === undefined ? '' : pc.dim(` (${bounded(finding.path)})`);
    return `${indent}${this.severityColor(finding)(`${F_FINDING} ${this.grade(finding)}`)}  ${bounded(collapseText(finding.title))}${location}`;
  }

  /** `high issue`, `low warning`. */
  private grade(finding: ReportExploreFinding): string {
    return `${SEVERITY_WORDS[finding.severity]} ${finding.kind}`;
  }

  private severityColor(finding: ReportExploreFinding): (text: string) => string {
    const { pc } = this;
    if (finding.kind === 'warning') return (text) => pc.dim(pc.yellow(text));
    if (finding.severity >= 4) return (text) => pc.bold(pc.red(text));
    if (finding.severity === 3) return (text) => pc.bold(pc.yellow(text));
    return pc.yellow;
  }

  /**
   * The live window's running area: the header with its clock, the finished
   * steps, and the step in progress with its latest calls and findings in
   * time order, or the planner deciding. Sized to the screen as the running
   * tree is: the step in progress has priority, older finished steps fold.
   */
  liveRows(badge: string, events: readonly ShownEvent[] | undefined, summary: readonly string[], now: number): string[] {
    const { pc } = this;
    const columns = terminalColumns() - WIDTH_MARGIN;
    const clock = pc.bold(pc.yellow(formatTime(Math.max(0, now - this.startedMs))));
    const lines = [`${this.header(badge, 'Exploring', columns - visibleWidth(clock) - 1)} ${clock}`];
    const capacity = terminalRows() - summary.length - CHROME_ROWS;
    let budget = capacity - 1;
    const current = this.currentRows(events, now, budget);
    budget -= current.length;
    const finished = this.steps.flatMap((step) => this.stepLines(step, LIVE_INDENT));
    if (budget > 0) {
      const folded = finished.length - budget + 1;
      lines.push(...(folded > 1 ? [`${LIVE_INDENT}${pc.dim(`… ${folded} earlier rows`)}`, ...finished.slice(folded)] : finished));
    }
    lines.push(...current);
    this.reservedRows = Math.min(capacity, Math.max(this.reservedRows, lines.length));
    while (lines.length < this.reservedRows) lines.push('');
    return ['', ...lines, '', ...summary, ''];
  }

  /** The step in progress, or the planner at work, at most `budget` rows. */
  private currentRows(events: readonly ShownEvent[] | undefined, now: number, budget: number): string[] {
    const { pc } = this;
    if (this.ended !== undefined || budget < 1) return [];
    if (this.open === undefined) {
      if (this.planning === undefined) return [];
      const what = this.planning === 'closing' ? 'the closing assessment' : `step ${this.steps.length + 1} of ${this.budgets.maxSteps}`;
      return [`${LIVE_INDENT}${pc.dim(`${F_DOWN_RIGHT} planning ${what}`)}`, `${LIVE_INDENT}  ${waitingRow(pc, now, 'Thinking')}`].slice(0, budget);
    }
    const { step } = this.open;
    const rows = [`${LIVE_INDENT}${pc.dim(`${F_DOWN_RIGHT} ${step.index}  `)}${bounded(step.title)} ${pc.dim(`(step ${step.index} of ${this.budgets.maxSteps})`)}`];
    const timeline = this.timeline(events ?? []);
    const shown = Math.min(MAX_EVENTS, Math.max(0, budget - 2));
    const overflow = timeline.length - shown;
    if (overflow > 0) rows.push(`${LIVE_INDENT}  ${pc.dim(`… ${overflow} earlier call${overflow === 1 ? '' : 's'}`)}`);
    for (const row of overflow > 0 ? timeline.slice(overflow) : timeline) rows.push(`${LIVE_INDENT}  ${row}`);
    rows.push(`${LIVE_INDENT}  ${waitingRow(pc, now, 'Thinking')}`);
    return rows.slice(0, budget);
  }

  /** The step's calls and its findings, interleaved by time; the finding tool's own call gives way to the finding. */
  private timeline(events: readonly ShownEvent[]): string[] {
    const maxWidth = terminalColumns() - WIDTH_MARGIN - LIVE_INDENT.length - 2;
    const rows = [
      ...events
        .filter((event) => event.name !== FINDING_TOOL_EVENT)
        .map((event) => ({ at: event.startedAt, row: eventLine(this.pc, event, { maxWidth }) })),
      ...(this.open?.findings ?? []).map((finding) => ({ at: finding.reportedAt, row: this.findingLine(finding, '') })),
    ];
    return rows.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((entry) => entry.row);
  }

  /** The summary's `Findings` and `Steps` rows, in place of `Test Files` and `Tests`. */
  summaryRows(): string[] {
    const { pc } = this;
    const issues = this.issues.length;
    const warnings = this.findings.length - issues;
    const findings =
      this.findings.length === 0
        ? pc.dim('none')
        : [
            ...(issues > 0 ? [pc.bold(pc.red(`${issues} issue${issues === 1 ? '' : 's'}`))] : []),
            ...(warnings > 0 ? [pc.yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`)] : []),
          ].join(pc.dim(' | '));
    const done = this.steps.length;
    const steps: string[] = [];
    if (this.ended === undefined) {
      steps.push(`${done} done of ${this.budgets.maxSteps}`);
      if (this.open !== undefined) steps.push(`step ${this.open.step.index} running`);
      else if (this.planning === 'closing') steps.push('closing');
      else if (this.planning === 'step') steps.push('planning');
    } else {
      steps.push(`${done} of ${this.budgets.maxSteps}`, ...this.outcomeParts(), pc.dim(ENDED_TEXT[this.ended]));
    }
    return [padTitle(pc, 'Findings') + findings, padTitle(pc, 'Steps') + steps.join(pc.dim(' · '))];
  }

  /** `3 passed`, `1 failed`, ... over the finished steps, zero counts left out, colored by status. */
  private outcomeParts(): string[] {
    const { pc } = this;
    const color = { passed: pc.green, failed: pc.red, exhausted: pc.yellow, blocked: pc.yellow } as const;
    return stepCountParts(this.steps.map(({ step }) => step)).map((part) => color[part.status](part.text));
  }

  /**
   * The permanent record once the run is over. With a live window
   * (`withSteps`) it was the steps' only home, so the header and every step
   * print here; without one they streamed as they finished, and only why the
   * exploration ended is left to say.
   */
  record(badge: string, withSteps: boolean): string[] {
    const { pc } = this;
    const lines = withSteps ? ['', this.header(badge, 'Explored'), ...this.steps.flatMap((step) => this.stepLines(step))] : [];
    if (this.steps.length === 0) lines.push(`${ROW_INDENT}${pc.dim('no step ran')}`);
    lines.push(`${ROW_INDENT}${pc.dim(`ended: ${ENDED_TEXT[this.ended ?? 'aborted']}`)}`);
    return lines;
  }

  /**
   * The `Findings` section: a banner, then one block per finding, issues
   * before warnings and the most severe first, each with where it was seen,
   * its screenshot, what was expected against what the screen showed, and
   * the actions that reach it.
   */
  findingsSection(displayPath: (target: string) => string, artifactsRoot: string | undefined): string[] {
    const { pc } = this;
    if (this.findings.length === 0) return [];
    const issues = this.issues.length;
    const lines = ['', this.banner(`Findings ${this.findings.length}`, issues > 0 ? pc.red : pc.yellow), ''];
    const ordered = orderFindings(this.findings);
    const columns = terminalColumns();
    ordered.forEach((finding, position) => {
      const number = `${String(position + 1).padStart(2)}. `;
      const grade = this.grade(finding);
      lines.push(`${number}${this.severityColor(finding)(grade.padEnd(16))} ${pc.bold(bounded(collapseText(finding.title)))}`);
      const where = [
        ...(finding.path === undefined ? [] : [bounded(finding.path)]),
        ...(finding.step === undefined ? [] : [`step ${finding.step}`]),
      ];
      if (where.length > 0) lines.push(`${DETAIL_INDENT}${pc.dim(where.join(' · '))}`);
      lines.push(...this.detail('expected', finding.expected, columns));
      lines.push(...this.detail('actual', finding.actual, columns));
      finding.reproduction.forEach((action, index) => {
        lines.push(...this.detail(index === 0 ? 'steps' : '', `${index + 1}. ${action}`, columns));
      });
      const screenshot = this.screenshot(finding, displayPath, artifactsRoot);
      if (screenshot !== undefined) lines.push(`${DETAIL_INDENT}${pc.dim('evidence'.padEnd(DETAIL_LABEL_WIDTH))}  ${pc.cyan(screenshot)}`);
      lines.push('');
    });
    return lines;
  }

  /** The report-relative path of a finding's screenshot, shown as the reporter shows paths. */
  private screenshot(
    finding: ReportExploreFinding,
    displayPath: (target: string) => string,
    artifactsRoot: string | undefined,
  ): string | undefined {
    if (finding.artifactId === undefined) return undefined;
    const artifact = this.artifacts.find((entry) => entry.id === finding.artifactId);
    if (artifact?.path === undefined) return undefined;
    return displayPath(artifactsRoot === undefined ? artifact.path : path.join(artifactsRoot, artifact.path));
  }

  /** `    expected  text…`, wrapped to the width with continuation lines under the text. */
  private detail(label: string, text: string, columns: number): string[] {
    const { pc } = this;
    const gutter = `${DETAIL_INDENT}${label.padEnd(DETAIL_LABEL_WIDTH)}  `;
    const blank = ' '.repeat(gutter.length);
    return wrap(collapseText(bounded(text)), Math.max(24, columns - gutter.length)).map(
      (line, index) => `${index === 0 ? `${DETAIL_INDENT}${pc.dim(label.padEnd(DETAIL_LABEL_WIDTH))}  ` : blank}${line}`,
    );
  }

  /** The agent's closing assessment, wrapped under its heading. */
  assessment(): string[] {
    const { pc } = this;
    if (this.summary === undefined) return [];
    const width = Math.max(24, terminalColumns() - ROW_INDENT.length - WIDTH_MARGIN);
    return [` ${pc.bold('Assessment')}`, ...wrap(bounded(this.summary), width).map((line) => `${ROW_INDENT}${line}`)];
  }

  private banner(message: string, color: (text: string) => string): string {
    const { pc } = this;
    const label = pc.bold(pc.inverse(` ${message} `));
    const { before, after } = rule(label, 'center');
    return `${color(before)}${color(label)}${color(after)}`;
  }
}

/** Greedy word wrap; a word longer than the width stands on its own line. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((part) => part !== '')) {
      if (line === '') line = word;
      else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) line = `${line} ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line !== '') lines.push(line);
  }
  return lines;
}
