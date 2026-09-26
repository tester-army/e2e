/** Renders a `bench-ab.ts` comparison as markdown ready for a pull request body. */

import type { CaseChange, Comparison, CounterRow, Spread, TimingRow } from './compare.ts';

export interface Header {
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: { readonly sha: string; readonly dirty: boolean };
  readonly suite: string;
  readonly command: string;
  readonly threshold: number;
  readonly floorMs: number;
  readonly stop: string;
  readonly machine: string;
  readonly suiteDiffers: boolean;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const rounded = (value * 100).toFixed(1);
  return value > 0 ? `+${rounded}%` : `${rounded}%`;
}

function spread(value: Spread): string {
  return `${duration(value.median)} (${duration(value.q1)}-${duration(value.q3)})`;
}

function timingTable(rows: readonly TimingRow[], label: string): string[] {
  return [
    `| ${label} | base median (IQR) | head median (IQR) | change (95% CI) | verdict |`,
    '| --- | ---: | ---: | ---: | --- |',
    ...rows.map((row) =>
      `| ${row.name.replaceAll('|', '\\|')} | ${spread(row.base)} | ${spread(row.head)} | ${percent(row.delta.estimate)} (${percent(row.delta.low)} to ${percent(row.delta.high)}) | ${row.delta.verdict}${row.belowFloor && row.delta.estimate !== 0 ? ', under the floor' : ''} |`),
  ];
}

function rangeText([min, max]: readonly [number, number]): string {
  return min === max ? String(min) : `${min}-${max}`;
}

function counterTable(rows: readonly CounterRow[]): string[] {
  return [
    '| Counter | base | head |',
    '| --- | ---: | ---: |',
    ...rows.map((row) => `| ${row.name} | ${rangeText(row.base)} | ${rangeText(row.head)} |`),
  ];
}

function changeLines(change: CaseChange): string[] {
  switch (change.kind) {
    case 'added':
      return [`- **added** ${change.key}`];
    case 'removed':
      return [`- **removed** ${change.key}`];
    case 'unstable':
      return [`- **unstable on ${change.side}** (${change.variants} different step sequences) ${change.key}`];
    case 'changed': {
      const base = change.base.split('\n');
      const head = change.head.split('\n');
      const lines: string[] = [];
      for (let index = 0; index < Math.max(base.length, head.length); index += 1) {
        if (base[index] === head[index]) continue;
        if (base[index] !== undefined) lines.push(`- ${base[index]!.trim()}`);
        if (head[index] !== undefined) lines.push(`+ ${head[index]!.trim()}`);
      }
      return [`- **changed** ${change.key}`, '', '  ```diff', ...lines.slice(0, 12).map((line) => `  ${line}`), '  ```'];
    }
  }
}

/** The whole comparison: header, behavior, timings, counters, then the per-test rows folded. */
export function renderMarkdown(header: Header, comparison: Comparison): string {
  const out = [
    `### bench-ab: \`${header.base.sha.slice(0, 8)}\` (${header.base.ref}) vs \`${header.head.sha.slice(0, 8)}\`${header.head.dirty ? ' + uncommitted changes' : ''}`,
    '',
    `${header.suite}: \`${header.command}\`. ${comparison.pairs} pairs in random order, ${header.stop}. Threshold ±${(header.threshold * 100).toFixed(0)}% and ${header.floorMs} ms. ${header.machine}.`,
  ];
  if (header.suiteDiffers) {
    out.push('', '> The suite\'s tests or config differ between base and head, so each side ran its own. A timing change can be the test change.');
  }
  out.push('', '#### Behavior', '');
  if (comparison.changes.length === 0) out.push('Every test ran the same steps with the same outcome on every run of both builds.');
  else {
    out.push('These tests are left out of the timing rows below.', '');
    for (const change of comparison.changes) out.push(...changeLines(change));
  }
  out.push('', '#### Timings', '', ...timingTable(comparison.timings, 'Metric'));
  out.push('', '#### Counters', '');
  if (comparison.counters.length === 0) out.push('Every counter matched on every run of both builds.');
  else out.push(...counterTable(comparison.counters));
  out.push('', `<details><summary>Tests outside the threshold: ${comparison.cases.length} of ${comparison.casesCompared}</summary>`, '');
  if (comparison.cases.length > 0) out.push(...timingTable(comparison.cases, 'Test'), '');
  const expected = comparison.casesCompared * 0.05;
  out.push(`With ${comparison.casesCompared} tests compared at 95%, about ${expected.toFixed(1)} could land outside by chance.`, '', '</details>', '');
  return out.join('\n');
}
