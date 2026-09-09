/**
 * The running part of the list reporter's live window: each running file,
 * its tests with a ticking clock, each test's finished steps, and its current
 * step with the model turns and tool calls so far and the turn in flight.
 * Padded to a fixed height so the summary below never moves.
 */

import { bounded, F_POINTER, formatTime, terminalColumns, terminalRows, type Colors } from './format.ts';
import type { FileGroup, RunningTest, SetupInFlight } from './list-model.ts';
import { eventLine, stepLabel, stepLine } from './list-steps.ts';
import { REPAINT_INTERVAL_MS, WIDTH_MARGIN } from './live-window.ts';

const F_DOWN_RIGHT = '↳';
const F_TREE_MIDDLE = '├──';
const F_TREE_END = '└──';
/**
 * Spinner for the turn in flight: an asterisk blooming and folding back.
 * Centered dingbats, unlike six-dot braille, which sits in the top-left of
 * its cell.
 */
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/** Frames each spinner glyph holds; the bloom reads better slower than the shimmer. */
const SPINNER_HOLD_FRAMES = 2;
/** Frames the shimmer rests after each sweep across the status word. */
const SHIMMER_REST_FRAMES = 6;

/** Indentation of a running test's detail (steps, calls) under its row. */
const DETAIL_INDENT = '       ';
/**
 * Rows the window spends outside the running tests and the summary: its
 * blank lines, the `… more running` marker, and a margin above the prompt.
 */
const CHROME_ROWS = 6;
/**
 * Rows reserved for the running area from the first paint: one file row, one
 * test row, its current step, the calls the window shows, the turn in flight,
 * and a few finished steps. The area never shrinks during the run, so the
 * summary below it stays put instead of jumping as calls come and go.
 */
const RESERVED_ROWS = 14;
/**
 * Most recent calls of a step the window shows; older ones fold into the
 * `… earlier calls` marker so a tall terminal does not fill with model turns.
 */
const MAX_EVENTS = 6;

/**
 * A bright highlight sweeping over `word` one character per frame, resting a
 * few frames between sweeps: the status word reads as alive without moving.
 */
function shimmer(pc: Colors, word: string, frame: number): string {
  const chars = [...word];
  const head = frame % (chars.length + SHIMMER_REST_FRAMES);
  return chars
    .map((char, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return pc.bold(pc.white(char));
      if (distance === 1) return pc.white(char);
      return pc.dim(char);
    })
    .join('');
}

/** `… N earlier things` folding rows that do not fit. */
function foldMarker(pc: Colors, count: number, noun: string): string {
  return pc.dim(`… ${count} earlier ${noun}${count === 1 ? '' : 's'}`);
}

export class RunningTree {
  /** High-water mark of the running area's rows; the window pads up to it. */
  private reservedRows = RESERVED_ROWS;

  constructor(
    private readonly pc: Colors,
    private readonly badge: (target: string) => string,
  ) {}

  /**
   * The window's rows: running files and tests with their detail, then the
   * summary. The block must fit the screen, because repainting more rows
   * than the terminal has breaks the cursor-up erase: rows left after the
   * summary go to the running tests, each test's detail shares what remains
   * once every test has its own row, and tests that still do not fit fold
   * into one `more running` marker.
   */
  render(
    running: readonly RunningTest[],
    summary: readonly string[],
    now: number,
    setup?: SetupInFlight,
  ): string[] {
    const { pc } = this;
    const active = new Map<FileGroup, RunningTest[]>();
    for (const test of running) {
      const tests = active.get(test.group);
      if (tests === undefined) active.set(test.group, [test]);
      else tests.push(test);
    }
    const capacity = terminalRows() - summary.length - CHROME_ROWS;
    let budget = capacity;
    const perTest = Math.max(
      0,
      Math.floor((budget - active.size - running.length) / Math.max(1, running.length)),
    );
    const maxEvents = Math.min(MAX_EVENTS, perTest);
    const lines: string[] = [];
    let hidden = 0;
    if (setup !== undefined && budget > 0) {
      lines.push(
        `${pc.bold(pc.yellow(` ${F_POINTER} `))}${pc.dim(setup.verb)} ${setup.subject} ${this.clock(now - setup.startedMs)}`,
      );
      budget -= 1;
    }
    for (const [group, tests] of active) {
      if (budget < 2) {
        hidden += tests.length;
        continue;
      }
      const progress = pc.dim(` ${group.lines.length}/${group.planned ?? '?'}`);
      lines.push(
        `${pc.bold(pc.yellow(` ${F_POINTER} `))}${this.badge(group.target)} ${bounded(group.file)}${progress}`,
      );
      budget -= 1;
      tests.forEach((test, index) => {
        if (budget < 1) {
          hidden += 1;
          return;
        }
        const glyph = index === tests.length - 1 ? F_TREE_END : F_TREE_MIDDLE;
        lines.push(`${pc.bold(pc.yellow(`   ${glyph} `))}${test.title} ${this.clock(now - test.startedMs)}`);
        budget -= 1;
        const detail = this.detailRows(test, maxEvents, Math.min(perTest, budget), now);
        lines.push(...detail);
        budget -= detail.length;
      });
    }
    if (hidden > 0) lines.push(pc.dim(`   … ${hidden} more running`));
    // Pad the running area to its reserved height so the summary does not move.
    this.reservedRows = Math.min(capacity, Math.max(this.reservedRows, lines.length));
    while (lines.length < this.reservedRows) lines.push('');
    return ['', ...lines, '', ...summary, ''];
  }

  /** The one ticking clock of a running test, on its row. */
  private clock(elapsedMs: number): string {
    return this.pc.bold(this.pc.yellow(formatTime(Math.max(0, elapsedMs))));
  }

  /**
   * Everything under a running test's row: its finished steps, then the
   * current step. The current step has priority; finished steps take the rows
   * left and the oldest fold into one marker.
   */
  private detailRows(test: RunningTest, maxEvents: number, budget: number, now: number): string[] {
    const current = this.stepRows(test, maxEvents, budget, now);
    const room = budget - current.length;
    const maxWidth = terminalColumns() - WIDTH_MARGIN - DETAIL_INDENT.length;
    const rendered = test.steps.map((step) => stepLine(this.pc, step, { maxWidth }));
    let finished: string[] = [];
    if (room > 0) {
      const folded = rendered.length - room + 1;
      finished = folded > 1 ? [foldMarker(this.pc, folded, 'step'), ...rendered.slice(folded)] : rendered;
    }
    return [...finished, ...current].map((row) => `${DETAIL_INDENT}${row}`);
  }

  /**
   * The current step of a running pair and, for an agent step, its calls and
   * the turn in flight, at most `budget` rows. Older calls fold into one
   * marker. No clock here: the test row above carries the one clock, so the
   * eye has a single moving number per running test.
   */
  private stepRows(test: RunningTest, maxEvents: number, budget: number, now: number): string[] {
    const { pc } = this;
    const { current } = test;
    if (current === undefined) return [];
    const rows = [pc.dim(`${F_DOWN_RIGHT} ${current.api} ${stepLabel(current.label)}`)];
    if (current.kind !== 'agent') return rows.slice(0, budget);
    const overflow = current.events.length - maxEvents;
    if (overflow > 0) rows.push(`  ${foldMarker(pc, overflow, 'call')}`);
    for (const event of overflow > 0 ? current.events.slice(overflow) : current.events) {
      rows.push(`  ${eventLine(pc, event)}`);
    }
    rows.push(`  ${this.waitingRow(now)}`);
    return rows.slice(0, budget);
  }

  /**
   * The model turn in flight: a spinner and a shimmering `Thinking`. Tool
   * calls take milliseconds and their turn is reported right after them, so
   * between events the model is always the one working.
   */
  private waitingRow(now: number): string {
    const { pc } = this;
    const frame = Math.floor(now / REPAINT_INTERVAL_MS);
    const spinner = pc.cyan(SPINNER_FRAMES[Math.floor(frame / SPINNER_HOLD_FRAMES) % SPINNER_FRAMES.length]!);
    return `${spinner} ${shimmer(pc, 'Thinking', frame)}`;
  }
}
