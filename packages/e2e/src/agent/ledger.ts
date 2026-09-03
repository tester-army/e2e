/**
 * Prior-step context for agent prompts (spec 10-determinism.md).
 *
 * The ledger is not stored anywhere: it is derived on demand from the step
 * timeline the run layer already records, so there is exactly one account of
 * what happened. Serial-group members see each other's prior steps through the
 * shared accumulator the run layer maintains; independent tests never do.
 * Entries are untrusted quoted evidence and never carry policy authority.
 *
 * Every entry has two renderings. The full one carries the step's whole
 * hand-off: the actions the runner recorded (`did`), the text that appeared on
 * screen (`saw`), the facts the model noted (`noted`), and its summary
 * (`observed`). The compact one keeps only what a later step can act on —
 * the head plus `saw` and `noted` — and consecutive passed checks fold into
 * one line. Under the byte budget, compact renderings of every step come
 * first, then the newest steps are upgraded to full while room remains, and
 * only then are the oldest dropped: a fact from step two reaches step fifty
 * before step forty-nine's prose does.
 */

import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { StepRecord } from '../run/steps.ts';

/** Maximum size of one handoff, before ledger-wide compaction. */
export const MAX_HANDOFF_BYTES = 700;

/**
 * Share of the handoff the recorded action trail may take. The trail is the
 * runner's own account of what the step did — every committed action, in
 * order, with the values it typed and the options it picked — so a later step
 * reads facts ("typed \"Nimbus Paper Co\" into textbox \"Supplier name\"") rather
 * than only the model's recollection of them.
 */
export const MAX_TRAIL_BYTES = 300;

/** Bound on the `saw` and `noted` lines together; they survive compaction, so they stay short. */
export const MAX_FACTS_BYTES = 240;

/** Newest agent steps rendered in full before anything older is considered. */
const RECENT_FULL_ENTRIES = 3;
/** Value of those newest entries: dropped only after everything else. */
const RECENT_VALUE = 4;
/** Label length in a compact entry; the step's gist, not its whole instruction. */
const MAX_COMPACT_LABEL_BYTES = 56;
/** Bound on the fact lines of a compact entry. */
const MAX_COMPACT_FACTS_BYTES = 120;

/**
 * What a later step loses if this entry goes: nothing it can act on for a
 * passed check (0), what was done for an agent step (1), the facts the model
 * noted (2), or text the app itself put on screen (3) — the one account no
 * later step can reconstruct.
 */
function entryValue(step: StepRecord): number {
  if (step.kind !== 'agent') return 0;
  const handoff = step.handoff;
  if (handoff === undefined) return 1;
  if (handoff.appeared.length > 0) return 3;
  return novelNotes(step).length > 0 ? 2 : 1;
}

const MAX_LABEL_BYTES = 256;

export interface LedgerContext {
  readonly text: string;
  readonly bytes: number;
}

const encoder = new TextEncoder();

function bytesOf(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Serializes completed steps as prompt context within `maxBytes`: compact
 * renderings of every entry first, newest entries upgraded to full renderings
 * while the budget allows, oldest entries dropped (and counted) only when even
 * the compact renderings do not fit. Presented in chronological order.
 */
export function serializeLedger(steps: readonly StepRecord[], maxBytes: number): LedgerContext {
  const entries = steps.map((step, index) => ({
    full: formatEntry(step, index + 1),
    compact: formatCompact(step, index + 1),
    deterministic: step.kind !== 'agent',
    value: entryValue(step),
  }));
  const folded = foldChecks(entries.map((entry) => entry.compact));
  // One rendered line per folded position, with how much it weighs and how
  // much a later step loses without it: a check says only that something
  // held, a fact-less agent step says what was done, a step with facts says
  // something later steps may need to reuse.
  const lines: LedgerLine[] = folded.map((line) => ({
    text: line.text,
    positions: line.positions,
    bytes: bytesOf(`${line.text}\n`),
    value: Math.max(...line.positions.map((position) => (entries[position] as (typeof entries)[number]).value)),
    dropped: false,
  }));
  // The newest agent steps are what the next step continues from ("the order
  // you just created"): they start out full and are the last thing dropped.
  let recent = 0;
  for (let index = lines.length - 1; index >= 0 && recent < RECENT_FULL_ENTRIES; index -= 1) {
    const line = lines[index] as LedgerLine;
    if (line.positions.length !== 1) continue;
    const entry = entries[line.positions[0] as number] as (typeof entries)[number];
    if (entry.deterministic) continue;
    line.text = entry.full;
    line.bytes = bytesOf(`${entry.full}\n`);
    line.value = RECENT_VALUE;
    recent += 1;
  }
  let used = lines.reduce((sum, line) => sum + line.bytes, 0);
  // Drop the least valuable line until the ledger fits, and within a value
  // the middle of the flow before either end: the first steps say where the
  // flow started and what it was given, the last say where it stands. Gap
  // markers are cheap and counted as they arise.
  for (const value of [0, 1, 2, 3, RECENT_VALUE]) {
    const candidates = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.value === value)
      .toSorted(
        (a, b) =>
          Math.min(b.index, lines.length - 1 - b.index) - Math.min(a.index, lines.length - 1 - a.index),
      );
    for (const { line } of candidates) {
      if (used + gapBytes(lines) <= maxBytes) break;
      line.dropped = true;
      used -= line.bytes;
    }
  }
  used += gapBytes(lines);
  // Upgrade the remaining agent entries to full renderings, newest first,
  // while room remains.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as LedgerLine;
    if (line.dropped || line.value === RECENT_VALUE || line.positions.length !== 1) continue;
    const entry = entries[line.positions[0] as number] as (typeof entries)[number];
    if (entry.deterministic) continue;
    const delta = bytesOf(`${entry.full}\n`) - line.bytes;
    if (used + delta > maxBytes) continue;
    used += delta;
    line.text = entry.full;
  }
  const text = renderWithGaps(lines).join('\n');
  return { text, bytes: bytesOf(text) };
}

interface LedgerLine {
  text: string;
  /** Zero-based step positions this line stands for; several for a folded run of checks. */
  readonly positions: readonly number[];
  bytes: number;
  value: number;
  dropped: boolean;
}

/** Bytes the gap markers for the current drops will cost. */
function gapBytes(lines: readonly LedgerLine[]): number {
  return renderGaps(lines).reduce((sum, marker) => sum + bytesOf(`${marker}\n`), 0);
}

/** The gap markers alone, one per run of dropped lines. */
function renderGaps(lines: readonly LedgerLine[]): string[] {
  return renderWithGaps(lines).filter((line) => line.startsWith('['));
}

/**
 * Kept lines in order, with one marker per run of dropped steps. A run at the
 * very start keeps the classic "earlier steps omitted" wording; a run in the
 * middle names the positions, so the numbering around it still reads.
 */
function renderWithGaps(lines: readonly LedgerLine[]): string[] {
  const out: string[] = [];
  let run: { first: number; last: number } | undefined;
  const flush = (): void => {
    if (run === undefined) return;
    const count = run.last - run.first + 1;
    out.push(
      out.length === 0
        ? `[${String(count)} earlier step(s) omitted]`
        : `[steps ${String(run.first + 1)}–${String(run.last + 1)} omitted]`,
    );
    run = undefined;
  };
  for (const line of lines) {
    if (line.dropped) {
      const first = line.positions[0] as number;
      const last = line.positions[line.positions.length - 1] as number;
      if (run === undefined) run = { first, last };
      else run.last = last;
      continue;
    }
    flush();
    out.push(line.text);
  }
  flush();
  return out;
}

/**
 * Full rendering: head, action trail, what appeared, noted facts, summary.
 *
 * A step the trace cache replayed zero-turn has no summary of its own: its
 * `explanation` quotes the verdict recorded on an earlier run, whose data
 * (a code the app issued then) may not be this run's. Its `did` and `saw`
 * lines are this run's, so they stand alone.
 */
function formatEntry(step: StepRecord, position: number): string {
  const lines = [head(step, position)];
  const trail = actionTrail(step);
  if (trail !== '') lines.push(`   did: ${trail}`);
  lines.push(...factLines(step));
  if (step.explanation !== undefined && step.cache?.mode !== 'self-finalized') {
    const budget = MAX_HANDOFF_BYTES - bytesOf(trail) - bytesOf(factLines(step).join(''));
    lines.push(`   observed: ${truncateUtf8(sanitizeText(step.explanation), Math.max(200, budget))}`);
  }
  return lines.join('\n');
}

/** Compact rendering: a short head plus the facts a later step can act on. */
function formatCompact(step: StepRecord, position: number): string {
  return [head(step, position, MAX_COMPACT_LABEL_BYTES), ...factLines(step, MAX_COMPACT_FACTS_BYTES)].join(
    '\n',
  );
}

function head(step: StepRecord, position: number, maxLabelBytes = MAX_LABEL_BYTES): string {
  const clean = sanitizeText(step.label);
  const label = bytesOf(clean) > maxLabelBytes ? `${truncateUtf8(clean, maxLabelBytes - 1)}…` : clean;
  return `${String(position)}. ${step.api} ${step.status}${label === '' ? '' : ` :: ${label}`}`;
}

/** The `saw` and `noted` lines, bounded together. */
function factLines(step: StepRecord, maxBytes = MAX_FACTS_BYTES): string[] {
  const handoff = step.handoff;
  if (handoff === undefined) return [];
  const lines: string[] = [];
  let budget = maxBytes;
  const emit = (prefix: string, items: readonly string[]): void => {
    const cleaned = items.map((item) => sanitizeText(item)).filter((item) => item !== '');
    if (cleaned.length === 0) return;
    const text = truncateUtf8(cleaned.join(' | '), Math.max(0, budget));
    if (text === '') return;
    budget -= bytesOf(text);
    lines.push(`   ${prefix}: ${text}`);
  };
  emit('saw', handoff.appeared);
  emit('noted', novelNotes(step));
  return lines;
}

/**
 * The model's noted facts worth carrying: not what the screen already states
 * verbatim, and not a restatement of the step's own instruction — a fact
 * whose every word is in the label ("Small Binder stock: 5" for "Set the
 * stock of Small Binder to 5") tells a later step nothing the ledger head
 * does not.
 */
function novelNotes(step: StepRecord): string[] {
  const handoff = step.handoff;
  if (handoff === undefined) return [];
  const sawText = handoff.appeared.join(' | ');
  const known = new Set(tokens(step.label));
  return handoff.noted.filter((fact) => {
    const trimmed = fact.trim();
    if (trimmed === '' || sawText.includes(trimmed)) return false;
    return tokens(trimmed).some((token) => !known.has(token));
  });
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
}

/**
 * The step's committed actions as one bounded line, from the action events
 * the run layer already records (their `detail` is redacted prose). Actions
 * are kept in order from the first: a form's values matter more than the
 * final tap, and the cut is marked so the reader knows the trail continues.
 */
function actionTrail(step: StepRecord): string {
  const details = step.events
    .filter((event) => event.kind === 'backend' && event.status === 'passed')
    .map((event) => event.detail)
    .filter((detail): detail is string => detail !== undefined && detail !== '');
  if (details.length === 0) return '';
  const parts: string[] = [];
  let bytes = 0;
  for (const detail of details) {
    const text = sanitizeText(detail);
    const size = bytesOf(`${text}; `);
    if (bytes + size > MAX_TRAIL_BYTES) {
      parts.push(`… +${String(details.length - parts.length)} more`);
      break;
    }
    bytes += size;
    parts.push(text);
  }
  return parts.join('; ');
}

const CHECK_HEAD = /^(\d+)\. (expect\.[A-Za-z]+|locator\.[A-Za-z]+) passed :: /;

/**
 * Folds runs of consecutive passed checks into one line each. In compact form
 * a check says only that something held; three of them in a row say it three
 * times. Each folded line remembers the step positions it stands for, so a
 * dropped fold counts as the steps it hid and the numbering around it holds.
 */
function foldChecks(lines: readonly string[]): { text: string; positions: readonly number[] }[] {
  const out: { text: string; positions: readonly number[] }[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push(
      run.length === 1
        ? { text: lines[run[0] as number] as string, positions: [...run] }
        : {
            text: `${String((run[0] as number) + 1)}–${String((run[run.length - 1] as number) + 1)}. ${String(run.length)} checks passed`,
            positions: [...run],
          },
    );
    run = [];
  };
  lines.forEach((line, index) => {
    if (CHECK_HEAD.test(line)) {
      run.push(index);
      return;
    }
    flush();
    out.push({ text: line, positions: [index] });
  });
  flush();
  return out;
}
