/**
 * Scores an `explore` report against the bug garden's planted defects. A
 * finding counts for a defect when its text matches every pattern of that
 * defect. Findings that match no defect go through the adjudication file:
 * ones a human has already judged score as false positives or as valid
 * unplanted findings; the rest are `other`, listed for a human to judge once
 * and add to the file, so the bucket shrinks with every run instead of being
 * re-read every time. On the clean garden every issue is a false positive,
 * whatever it matches.
 */

import { readFileSync } from 'node:fs';
import type { Finding, Report } from './report-data.ts';

export interface PlantedDefect {
  readonly id: string;
  readonly kind: string;
  /** Every pattern must match the finding's title, expected, and actual text joined. */
  readonly patterns: readonly RegExp[];
}

/** The garden's defects (`packages/testbed/app/bug-garden.mjs` documents them). */
export const PLANTED_DEFECTS: readonly PlantedDefect[] = [
  { id: 'B1', kind: 'navigation', patterns: [/help/i, /hlep|404|not found|nothing at/i] },
  { id: 'B2', kind: 'dead control', patterns: [/add to cart/i, /nothing|no effect|no visible|unresponsive|dead|does not|doesn.t|did not|didn.t|stays|remains|not added|never/i] },
  { id: 'B3', kind: 'calculation', patterns: [/total/i, /quantit|qty|line|sum|ignore|incorrect|wrong|mismatch|should be|expected/i] },
  { id: 'B4', kind: 'wrong target', patterns: [/remov/i, /wrong|first|different|other|instead|another/i] },
  { id: 'B5', kind: 'persistence', patterns: [/name|profile|account/i, /sav|persist|revert/i, /old|previous|unchanged|revert|not (updated|changed|saved|persist|kept|applied|reflected)|still shows|did not (update|change|persist|stick)|lost|discard/i] },
  { id: 'B6', kind: 'dates', patterns: [/1970|1969|before (the|it was) (order|placed)|delivery date|placed on/i] },
  { id: 'B7', kind: 'security', patterns: [/password/i, /plain ?text|in (the )?clear|clear ?text|unmasked|not masked|no(t)? mask|readable|type="?text|visible (as|while) (you )?typ|exposed|echo|shows the (typed|entered)|displayed (as|in) (plain|clear)/i] },
  { id: 'B8', kind: 'copy', patterns: [/\{\{\s*userName\s*\}\}|template|placeholder token|unrendered|interpolat/i] },
  { id: 'B9', kind: 'data', patterns: [/stock/i, /-3|negative|minus|below zero/i] },
  { id: 'B10', kind: 'inconsistency', patterns: [/orders?/i, /count|2 orders|says (2|two)|one order|only one|mismatch|list(s|ed)? (only )?1|single/i] },
  { id: 'W1', kind: 'copy (minor)', patterns: [/recieve|misspell|typo|spelling/i] },
];

export type AdjudicationVerdict = 'false-positive' | 'valid-unplanted';

export interface Adjudication {
  /** A regular expression source matched against the finding text, case-insensitive. */
  readonly pattern: string;
  readonly verdict: AdjudicationVerdict;
  readonly note: string;
}

/** Loads `adjudications.json`, a list of `{ pattern, verdict, note }`. */
export function readAdjudications(file: string): Adjudication[] {
  return JSON.parse(readFileSync(file, 'utf8')) as Adjudication[];
}

export interface ExploreScore {
  readonly ended: string;
  readonly steps: number;
  readonly findings: number;
  /** Planted defect ids found, each once. */
  readonly found: readonly string[];
  readonly duplicates: number;
  /** Findings a human judged as real defects the garden did not plant. */
  readonly validUnplanted: readonly string[];
  /** Findings judged not to be defects, plus every issue on the clean garden. */
  readonly falsePositives: readonly string[];
  /** Findings nobody has judged yet. */
  readonly other: readonly string[];
  /** Findings that carry a screenshot artifact, over all findings. */
  readonly evidenceRate: number | undefined;
  readonly firstFindingMs: number | undefined;
}

/** Scores one exploration; `clean` says the garden had no defects to find. */
export function scoreExplore(report: Report, adjudications: readonly Adjudication[], clean: boolean): ExploreScore {
  const explore = report.run.explore ?? { ended: 'unknown', steps: [], findings: [] };
  const hits = new Map<string, number>();
  const validUnplanted: string[] = [];
  const falsePositives: string[] = [];
  const other: string[] = [];
  for (const finding of explore.findings) {
    const label = describe(finding);
    if (clean) {
      // A warning about working software is noise, not a false defect; only issues count against the model.
      if (finding.kind === 'issue') falsePositives.push(label);
      continue;
    }
    const text = `${finding.title}\n${finding.expected}\n${finding.actual}`;
    const defect = PLANTED_DEFECTS.find((candidate) => candidate.patterns.every((pattern) => pattern.test(text)));
    if (defect !== undefined) {
      hits.set(defect.id, (hits.get(defect.id) ?? 0) + 1);
      continue;
    }
    const verdict = adjudications.find((entry) => new RegExp(entry.pattern, 'i').test(text))?.verdict;
    if (verdict === 'false-positive') falsePositives.push(label);
    else if (verdict === 'valid-unplanted') validUnplanted.push(label);
    else other.push(label);
  }
  const startedAt = Date.parse(report.run.startedAt);
  const first = explore.findings
    .map((finding) => Date.parse(finding.reportedAt))
    .filter(Number.isFinite)
    .toSorted((a, b) => a - b)[0];
  const withEvidence = explore.findings.filter((finding) => finding.artifactId !== undefined).length;
  return {
    ended: explore.ended,
    steps: explore.steps.length,
    findings: explore.findings.length,
    found: [...hits.keys()],
    duplicates: [...hits.values()].reduce((sum, count) => sum + count - 1, 0),
    validUnplanted,
    falsePositives,
    other,
    evidenceRate: explore.findings.length === 0 ? undefined : withEvidence / explore.findings.length,
    firstFindingMs: first === undefined ? undefined : first - startedAt,
  };
}

function describe(finding: Finding): string {
  return `[${finding.kind} S${String(finding.severity)}] ${finding.title}`;
}
