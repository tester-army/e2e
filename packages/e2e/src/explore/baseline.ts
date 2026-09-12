/**
 * The baseline of an exploration: the findings of an earlier `e2e explore`
 * run, read from its `report.json`, that this run's findings are told apart
 * from. A finding that reads like one the baseline holds is `known`; any
 * other is `new`; a baseline finding nothing matched was `not seen`. The
 * matching is text similarity over what the agent wrote, model-free and the
 * same on every run, so the labels are a reading aid for whoever compares
 * two states of an app (a branch against its base, a release against the
 * last), never a verdict: the run still fails on any issue it found.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import type { ReportExploreFinding } from '../report/build.ts';

/** What the baseline keeps of one earlier finding: enough to match against and to name. */
export type BaselineFinding = Pick<ReportExploreFinding, 'id' | 'kind' | 'severity' | 'title' | 'expected' | 'actual'>;

export interface LoadedBaseline {
  /** The report's location as the reader should see it: relative to the project root when inside it. */
  readonly source: string;
  readonly goal: string;
  readonly findings: readonly BaselineFinding[];
}

/** A finding as it is matched: the text fields the agent wrote. */
export type MatchInput = Pick<ReportExploreFinding, 'title' | 'expected' | 'actual'>;

/**
 * Two findings are the same defect from this score up. Titles carry most of
 * the weight: two runs describe one bug with the same handful of words, and
 * the expected-and-actual text varies more with the screen state they met.
 */
export const MATCH_THRESHOLD = 0.45;
const TITLE_WEIGHT = 0.6;
const DETAIL_WEIGHT = 0.4;

/**
 * Words that carry no defect: two descriptions of one bug share these
 * whatever it is, and two bugs share them too, so they only blur the score.
 */
const STOP_WORDS = new Set(
  'the a an and or but not no of to in on at by for with from into under over after before when while than that this these those it its is are was were be been being has have had does do did should would could can will still only also very there here'.split(
    ' ',
  ),
);

/** Words of two or more letters or digits, lowercased, without punctuation or stop words; order and repeats dropped. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2 && !STOP_WORDS.has(word)),
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** How alike two findings read, 0 to 1; identical titles are 1 whatever the detail says. */
export function similarity(a: MatchInput, b: MatchInput): number {
  const titleA = tokens(a.title);
  const titleB = tokens(b.title);
  if (titleA.size > 0 && titleA.size === titleB.size && [...titleA].every((word) => titleB.has(word))) return 1;
  const detail = jaccard(tokens(`${a.expected} ${a.actual}`), tokens(`${b.expected} ${b.actual}`));
  return TITLE_WEIGHT * jaccard(titleA, titleB) + DETAIL_WEIGHT * detail;
}

/**
 * Tells this run's findings apart from the baseline's as they arrive. Each
 * baseline finding is matched at most once, to the first arrival that reads
 * like it, so two of this run's findings never both count as the same known
 * defect; the second is new, as a duplicate report of it would be.
 */
export class BaselineMatcher {
  readonly #unclaimed: BaselineFinding[];

  constructor(readonly baseline: LoadedBaseline) {
    this.#unclaimed = [...baseline.findings];
  }

  /** The baseline finding this one reads like, claimed; undefined when it reads like none left. */
  match(input: MatchInput): BaselineFinding | undefined {
    let best: { finding: BaselineFinding; score: number; index: number } | undefined;
    this.#unclaimed.forEach((finding, index) => {
      const score = similarity(input, finding);
      if (score >= MATCH_THRESHOLD && (best === undefined || score > best.score)) best = { finding, score, index };
    });
    if (best === undefined) return undefined;
    this.#unclaimed.splice(best.index, 1);
    return best.finding;
  }

  /** The baseline findings nothing in this run read like. */
  get notSeen(): readonly BaselineFinding[] {
    return this.#unclaimed;
  }
}

const MAX_BASELINE_FINDINGS = 200;

/**
 * Reads the baseline from an earlier run's `report.json`. Anything but a
 * report-1 document with an exploration record is `INVALID_BASELINE`, named
 * as a configuration error before anything starts, as a bad flag is.
 */
export function loadBaseline(file: string, projectRoot: string): LoadedBaseline {
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  const source = relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join(path.posix.sep);
  const fail = (reason: string): never => {
    throw new ConfigurationError('INVALID_BASELINE', `--baseline ${file}: ${reason}; pass the report.json of an earlier e2e explore run`);
  };
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (cause) {
    return fail(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT' ? 'no such file' : 'the file could not be read');
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail('not a JSON document');
  }
  if (!isRecord(document) || document.schemaVersion !== 'report-1' || !isRecord(document.run)) return fail('not a report-1 document');
  const explore = document.run.explore;
  if (!isRecord(explore) || typeof explore.goal !== 'string' || !Array.isArray(explore.findings)) {
    return fail('the report holds no exploration record (was it written by e2e explore?)');
  }
  const findings: BaselineFinding[] = [];
  for (const entry of explore.findings) {
    if (!isBaselineFinding(entry)) return fail('a finding in the report is malformed');
    findings.push({ id: entry.id, kind: entry.kind, severity: entry.severity, title: entry.title, expected: entry.expected, actual: entry.actual });
  }
  if (findings.length > MAX_BASELINE_FINDINGS) return fail(`the report holds ${findings.length} findings, the maximum is ${MAX_BASELINE_FINDINGS}`);
  return { source, goal: explore.goal, findings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBaselineFinding(value: unknown): value is BaselineFinding {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.kind === 'issue' || value.kind === 'warning') &&
    typeof value.severity === 'number' &&
    Number.isInteger(value.severity) &&
    value.severity >= 1 &&
    value.severity <= 5 &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    typeof value.expected === 'string' &&
    typeof value.actual === 'string'
  );
}
