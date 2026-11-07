/**
 * The merge after parallel explorers: explorers with different focuses on
 * the same goal often meet the same defect, so once they are over one
 * structured model call groups the findings that describe the same failure,
 * and the report keeps the most detailed of each group. Nothing is ever
 * dropped: an invalid grouping keeps every finding, and an index the model
 * leaves out stays a finding of its own.
 */

import { z } from 'zod';
import { failureUsage, type ModelAdapter, type ModelResult } from '../agent/model/adapter.ts';
import { errorMessage } from '../internal/errors.ts';
import { deriveJsonSchema } from '../agent/model/schema.ts';
import { ModelUsage } from '../agent/usage.ts';
import type { ReportExploreFinding, ReportMergedFinding } from '../report/build.ts';
import type { StepModelInfo } from '../run/steps.ts';
import type { ProviderOptions } from '../types.ts';
import { clip } from './state.ts';

/** The merge call's deadline: one small structured call, on a slow provider. */
const MERGE_TIMEOUT_MS = 120_000;
const MERGE_OUTPUT_TOKENS = 4_096;
/** A finding's actions as the merge reads them, at most. */
const MAX_REPRODUCTION_CHARS = 400;

const MERGE_SYSTEM = `You merge the bug reports of several testers who explored the same app at the same time, each with a different focus.
Group the reports that describe the same observable failure under the same conditions:
- The same failure on the same kind of screen with different data (another user, record, item, row, or account) is one group.
- Keep separate: the same kind of defect on different kinds of screens (a list of everything versus a list inside one record, a form versus a detail screen), different symptoms, and different inputs that fail differently.
Every index appears in exactly one group; a report with no duplicate is a group of its own.`;

const MERGE_SCHEMA = z.object({
  groups: z.array(z.array(z.number())).describe('Groups of report indices; every index in exactly one group.'),
});

export interface MergeSettings {
  readonly adapter: ModelAdapter;
  readonly maxInputTokens: number;
  readonly providerOptions: ProviderOptions | undefined;
  readonly signal: AbortSignal;
}

/** The merge call's answer, its grouping not yet validated, and what the call cost. */
export interface MergeAnswer {
  readonly groups: readonly (readonly number[])[];
  readonly usage: StepModelInfo;
}

/** The merge prompt's own version, recorded with the call's usage as a step's policy version is. */
const MERGE_POLICY_VERSION = 'explore-merge/1';

/** A merge call that failed, with what it cost when the provider answered before it failed. */
export class MergeCallError extends Error {
  constructor(
    readonly reason: unknown,
    readonly usage: StepModelInfo | undefined,
  ) {
    super(errorMessage(reason), { cause: reason });
    this.name = 'MergeCallError';
  }
}

/**
 * Asks the model once to group `findings`. A call that fails throws a
 * `MergeCallError` carrying the usage of the answer when there was one, an
 * answer outside the schema included.
 */
export async function requestGroups(findings: readonly ReportExploreFinding[], settings: MergeSettings): Promise<MergeAnswer> {
  const reports = findings.map((finding, index) => ({
    index,
    title: finding.title,
    expected: finding.expected,
    actual: finding.actual,
    // The inputs that tell two failures apart, bounded so many findings still fit one call.
    reproduction: clip(finding.reproduction.join(' / '), MAX_REPRODUCTION_CHARS),
    ...(finding.path === undefined ? {} : { path: finding.path }),
  }));
  const report = (usage: ModelResult<unknown>['usage']): StepModelInfo => {
    const accounted = new ModelUsage();
    accounted.record(usage);
    return accounted.report({ ...settings.adapter.provenance, policyVersion: MERGE_POLICY_VERSION }, 1);
  };
  let answer: ModelResult<z.output<typeof MERGE_SCHEMA>>;
  try {
    answer = await settings.adapter.generate({
      system: MERGE_SYSTEM,
      prompt: `Reports:\n${JSON.stringify(reports)}\n\nRespond with {"groups": [[...], ...]}.`,
      schemaName: 'explore-merge',
      schema: await deriveJsonSchema(MERGE_SCHEMA),
      validate: (value) => {
        const parsed = MERGE_SCHEMA.safeParse(value);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issue: parsed.error.message };
      },
      maxOutputTokens: MERGE_OUTPUT_TOKENS,
      maxInputTokens: settings.maxInputTokens,
      providerOptions: settings.providerOptions,
      signal: settings.signal,
      timeoutMs: MERGE_TIMEOUT_MS,
    });
  } catch (cause) {
    const usage = failureUsage(cause);
    throw new MergeCallError(cause, usage === undefined ? undefined : report(usage));
  }
  return { groups: answer.value.groups, usage: report(answer.usage) };
}

/**
 * The model's grouping of `count` findings as a partition, or an error
 * naming what is wrong with it: an index out of range, an index listed more
 * than once (within a group or across groups), or an empty group. An index
 * the model left out is a group of its own.
 */
export function validateGroups(groups: readonly (readonly number[])[], count: number): number[][] {
  const seen = new Set<number>();
  for (const group of groups) {
    if (group.length === 0) throw new Error('the merge answered an empty group');
    for (const index of group) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error(`the merge answered index ${String(index)}, out of range for ${String(count)} findings`);
      if (seen.has(index)) throw new Error(`the merge listed finding ${String(index)} more than once`);
      seen.add(index);
    }
  }
  const omitted = Array.from({ length: count }, (_, index) => index).filter((index) => !seen.has(index));
  return [...groups.map((group) => [...group]), ...omitted.map((index) => [index])];
}

/**
 * One finding per group of a validated partition, in the order each group
 * was first reported: the most detailed report, graded as the gravest of its
 * group so a merge never lowers a defect, with the others in `merged`.
 */
export function applyGroups(findings: readonly ReportExploreFinding[], partition: readonly (readonly number[])[]): ReportExploreFinding[] {
  return partition
    .map((group) => group.toSorted((a, b) => a - b))
    .toSorted((a, b) => a[0]! - b[0]!)
    .map((group, position) => {
      const kept = group.reduce((best, index) => (detail(findings[index]!) > detail(findings[best]!) ? index : best));
      const all = group.map((index) => findings[index]!);
      const others = group.filter((index) => index !== kept).map((index) => absorbed(findings[index]!));
      const issue = all.some((finding) => finding.kind === 'issue');
      const severity = all
        .filter((finding) => !issue || finding.kind === 'issue')
        .reduce<ReportExploreFinding['severity']>((gravest, finding) => (finding.severity > gravest ? finding.severity : gravest), 1);
      return {
        ...findings[kept]!,
        index: position,
        kind: issue ? 'issue' : 'warning',
        severity,
        ...(others.length === 0 ? {} : { merged: others }),
      };
    });
}

/** What the report keeps of a finding merged into another. */
function absorbed(finding: ReportExploreFinding): ReportMergedFinding {
  return {
    id: finding.id,
    title: finding.title,
    ...(finding.explorer === undefined ? {} : { explorer: finding.explorer }),
    ...(finding.step === undefined ? {} : { step: finding.step }),
    ...(finding.artifactId === undefined ? {} : { artifactId: finding.artifactId }),
  };
}

/** How much a report tells: the characters of what it expected, saw, and did. */
function detail(finding: ReportExploreFinding): number {
  return finding.expected.length + finding.actual.length + finding.reproduction.join('').length;
}
