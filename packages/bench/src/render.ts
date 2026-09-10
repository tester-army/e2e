/**
 * Renders a summary as Markdown tables, one per track, for the terminal, a
 * PR body, or the docs page. Numbers are rounded for reading; the JSON keeps
 * the precision.
 */

import type { ArmTrackAggregate } from './aggregate.ts';
import { PLANTED_DEFECTS } from './score-explore.ts';
import type { Summary } from './summary.ts';
import type { TrackId } from './tracks.ts';

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const money = (value: number | undefined, partial = false): string =>
  value === undefined ? '-' : `$${value.toFixed(value < 0.1 ? 4 : 3)}${partial ? '?' : ''}`;
const seconds = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value)}s`);
const count = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const thousands = (value: number): string => `${Math.round(value / 1000)}k`;

export function renderMarkdown(summary: Summary): string {
  const lines: string[] = [
    `# E2E Bench: ${summary.label}`,
    '',
    `e2e ${summary.provenance.e2eVersion} (${summary.provenance.commit.slice(0, 8)}), task set v${String(summary.taskSetVersion)}, ${String(summary.config.repeats)} repeat(s), ${summary.createdAt.slice(0, 10)}.`,
    '',
  ];
  for (const track of summary.config.tracks) {
    const rows = summary.rows.filter((row) => row.track === track);
    if (rows.length === 0) continue;
    lines.push(`## ${track}`, '', ...renderTrack(track, rows), '');
  }
  const failed = summary.runs.filter((run) => run.error !== undefined);
  if (failed.length > 0) {
    lines.push('## Runs without a report', '');
    for (const run of failed) lines.push(`- ${run.arm} / ${run.track} / r${String(run.repeat)}: ${run.error ?? ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** One track's table, arms as rows; the columns depend on the track's oracle. */
export function renderTrack(track: TrackId, rows: readonly ArmTrackAggregate[]): string[] {
  const usageHead = ['calls', 'tokens in/out', 'cached', 'reasoning', 'cost', 'list cost', 'time', 'model time'];
  const usageCells = (row: ArmTrackAggregate): string[] => [
    count(row.usage.calls),
    `${thousands(row.usage.inputTokens)}/${thousands(row.usage.outputTokens)}`,
    percent(row.usage.cacheShare),
    thousands(row.usage.reasoningTokens),
    money(row.usage.costUsd, row.usage.costPartial),
    money(row.usage.tableCostUsd),
    seconds(row.usage.seconds),
    seconds(row.usage.modelSeconds),
  ];
  const runsCell = (row: ArmTrackAggregate): string =>
    row.failedRuns === 0 ? String(row.runs) : `${String(row.runs - row.failedRuns)}/${String(row.runs)}`;

  if (track === 'judgment') {
    return table(
      ['arm', 'runs', 'caught', 'missed', 'false alarm', 'correct', 'inconclusive', ...usageHead],
      rows.map((row) => [
        row.arm,
        runsCell(row),
        String(row.judgment?.caught ?? 0),
        String(row.judgment?.missed ?? 0),
        String(row.judgment?.['false-alarm'] ?? 0),
        String(row.judgment?.correct ?? 0),
        String(row.judgment?.inconclusive ?? 0),
        ...usageCells(row),
      ]),
    );
  }
  if (track === 'explore' || track === 'explore-clean') {
    const clean = track === 'explore-clean';
    return table(
      [
        'arm',
        'runs',
        ...(clean ? [] : [`recall (${String(PLANTED_DEFECTS.length)})`, 'precision']),
        'false pos.',
        ...(clean ? [] : ['unplanted', 'other', 'dupes']),
        'stuck',
        'first finding',
        'evidence',
        ...usageHead,
      ],
      rows.map((row) => [
        row.arm,
        runsCell(row),
        ...(clean
          ? []
          : [
              percent(row.explore?.recall ?? 0),
              row.explore?.precision === undefined ? '-' : percent(row.explore.precision),
            ]),
        count(row.explore?.falsePositives ?? 0),
        ...(clean
          ? []
          : [count(row.explore?.validUnplanted ?? 0), count(row.explore?.other ?? 0), count(row.explore?.duplicates ?? 0)]),
        String(row.explore?.stuck ?? 0),
        seconds(row.explore?.firstFindingSeconds),
        row.explore?.evidenceRate === undefined ? '-' : percent(row.explore.evidenceRate),
        ...usageCells(row),
      ]),
    );
  }
  return table(
    ['arm', 'runs', 'tasks', 'pass rate', 'reliability', 'failure codes', ...usageHead],
    rows.map((row) => [
      row.arm,
      runsCell(row),
      row.tasks === undefined ? '-' : `${count(row.tasks.perRun - row.tasks.skipped)} (+${count(row.tasks.skipped)} gaps)`,
      percent(row.tasks?.passRate ?? 0),
      percent(row.tasks?.reliability ?? 0),
      Object.entries(row.tasks?.codes ?? {})
        .toSorted(([, a], [, b]) => b - a)
        .map(([code, n]) => `${code} ${String(n)}`)
        .join(', ') || '-',
      ...usageCells(row),
    ]),
  );
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)];
}
