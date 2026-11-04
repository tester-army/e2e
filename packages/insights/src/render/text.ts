import type { Insights, TestInsight } from '../analyze.ts';
import { cacheHotspots, cacheLine, costliest, dollars, duration, outcomeLine, percent, plain, rateCell, reasonsLine, slowest, title, tokens, UNHEALTHY, when, where } from './format.ts';

/** The analysis as plain terminal text: a headline, then one table per question worth asking. */
export function renderText(insights: Insights): string {
  if (insights.runs === 0) return 'No runs in the history yet. Add insights() to `reporters` and run e2e.\n';

  const lines: string[] = [];
  lines.push(
    `e2e insights: ${insights.runs} runs, ${insights.passedRuns} passed (${percent(insights.passedRuns, insights.runs)})`,
  );
  lines.push(`  ${when(insights.from)} → ${when(insights.to)}`);
  lines.push(
    `  ${insights.counts.broken} broken · ${insights.counts.failing} failing · ${insights.counts.flaky} flaky · ${insights.counts.new} new · ${insights.counts.stable} stable`,
  );
  if (insights.cache.steps > 0) {
    lines.push(`  Cache  ${cacheLine(insights.cache)} (${percent(insights.cache.replayed, insights.cache.steps)} replayed)`);
  }
  if (insights.modelTokens > 0 || insights.costUsd !== undefined) {
    lines.push(`  Model  ${tokens(insights.modelTokens)} tokens · ${dollars(insights.costUsd)}`);
  }

  const unhealthy = insights.tests.filter((test) => UNHEALTHY.has(test.verdict));
  lines.push('');
  if (unhealthy.length === 0) {
    lines.push(`No broken, failing, or flaky tests across the last ${insights.runs} runs.`);
  } else {
    lines.push('Broken, failing, and flaky');
    lines.push(
      table(
        ['Verdict', 'Test', 'Flake rate', 'Results', 'Same-commit flips', 'Top error'],
        unhealthy.map((test) => [
          test.verdict,
          testCell(test),
          rateCell(test),
          outcomeLine(test),
          String(test.sameCommitFlips),
          test.topErrorCode ? plain(test.topErrorCode) : '-',
        ]),
      ),
    );
  }

  const hotspots = cacheHotspots(insights.tests);
  if (hotspots.length > 0) {
    lines.push('');
    lines.push('Replay cache misses');
    lines.push(
      table(
        ['Test', 'Replayed', 'Missed + handed off', 'Model calls', 'Why'],
        hotspots.map((test) => [
          testCell(test),
          percent(test.cache.replayed, test.cache.steps),
          String(test.cache.missed + test.cache.handedOff),
          String(test.modelCalls),
          reasonsLine(test.cache) || '-',
        ]),
      ),
    );
  }

  const expensive = costliest(insights.tests, 5);
  if (expensive.length > 0) {
    lines.push('');
    lines.push('Model cost');
    lines.push(
      table(
        ['Test', 'Cost', 'Per run', 'Tokens'],
        expensive.map((test) => [
          testCell(test),
          dollars(test.costUsd),
          dollars(test.costUsd === undefined ? undefined : test.costUsd / test.runs),
          tokens(test.tokens),
        ]),
      ),
    );
  }

  lines.push('');
  lines.push('Slowest');
  lines.push(
    table(
      ['Test', 'Median', 'p95'],
      slowest(insights.tests, 5).map((test) => [testCell(test), duration(test.medianDurationMs), duration(test.p95DurationMs)]),
    ),
  );
  return lines.join('\n') + '\n';
}

function testCell(test: TestInsight): string {
  return `${title(test)} [${where(test)}]`;
}

/** Left-aligned columns separated by two spaces; long cells are cut so one title cannot push the table off screen. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cut = (cell: string): string => {
    const characters = Array.from(cell);
    return characters.length > 70 ? `${characters.slice(0, 69).join('')}…` : cell;
  };
  const all = [header, ...rows].map((row) => row.map(cut));
  const widths = header.map((_, column) => Math.max(...all.map((row) => Array.from(row[column] ?? '').length)));
  return all
    .map((row) =>
      row
        .map((cell, column) => cell + ' '.repeat(Math.max(0, (widths[column] ?? 0) - Array.from(cell).length)))
        .join('  ')
        .trimEnd(),
    )
    .map((line) => `  ${line}`)
    .join('\n');
}
