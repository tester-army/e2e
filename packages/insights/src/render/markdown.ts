import type { Insights, TestInsight } from '../analyze.ts';
import { cacheHotspots, cacheLine, costliest, dollars, duration, outcomeLine, percent, plain, rateCell, reasonsLine, slowest, title, tokens, UNHEALTHY, when, where } from './format.ts';

const VERDICT_LABEL: Record<string, string> = { broken: '🔴 broken', failing: '🟠 failing', flaky: '🟡 flaky' };

/** The analysis as GitHub-flavored Markdown, for a job summary or a pull request comment. */
export function renderMarkdown(insights: Insights): string {
  if (insights.runs === 0) return '### e2e insights\n\nNo runs in the history yet.\n';

  const out: string[] = [];
  out.push(
    `### e2e insights: ${insights.counts.broken} broken, ${insights.counts.failing} failing, ${insights.counts.flaky} flaky across ${insights.runs} runs`,
    '',
    `${insights.passedRuns} of ${insights.runs} runs passed (${percent(insights.passedRuns, insights.runs)}), ${when(insights.from)} to ${when(insights.to)}.`,
  );
  if (insights.cache.steps > 0) {
    out.push('', `Cache: ${cacheLine(insights.cache)} (${percent(insights.cache.replayed, insights.cache.steps)} replayed).`);
  }
  if (insights.modelTokens > 0 || insights.costUsd !== undefined) {
    out.push('', `Model: ${tokens(insights.modelTokens)} tokens, ${dollars(insights.costUsd)}.`);
  }

  const unhealthy = insights.tests.filter((test) => UNHEALTHY.has(test.verdict));
  if (unhealthy.length > 0) {
    out.push(
      '',
      '#### Broken, failing, and flaky',
      '',
      row(['Verdict', 'Test', 'Target', 'Flake rate', 'Results', 'Same-commit flips', 'Top error']),
      row(['---', '---', '---', '---:', '---', '---:', '---']),
      ...unhealthy.map((test) =>
        row([
          VERDICT_LABEL[test.verdict] ?? test.verdict,
          testCell(test),
          code(where(test)),
          rateCell(test),
          outcomeLine(test),
          String(test.sameCommitFlips),
          test.topErrorCode ? code(test.topErrorCode) : '-',
        ]),
      ),
    );
  } else {
    out.push('', `No broken, failing, or flaky tests across the last ${insights.runs} runs.`);
  }

  const hotspots = cacheHotspots(insights.tests);
  if (hotspots.length > 0) {
    out.push(
      '',
      '<details><summary>Replay cache misses</summary>',
      '',
      row(['Test', 'Replayed', 'Missed + handed off', 'Model calls', 'Why']),
      row(['---', '---:', '---:', '---:', '---']),
      ...hotspots.map((test) =>
        row([
          testCell(test),
          percent(test.cache.replayed, test.cache.steps),
          String(test.cache.missed + test.cache.handedOff),
          String(test.modelCalls),
          escape(reasonsLine(test.cache)) || '-',
        ]),
      ),
      '',
      '</details>',
    );
  }

  const expensive = costliest(insights.tests, 5);
  if (expensive.length > 0) {
    out.push(
      '',
      '<details><summary>Model cost</summary>',
      '',
      row(['Test', 'Cost', 'Per run', 'Tokens']),
      row(['---', '---:', '---:', '---:']),
      ...expensive.map((test) =>
        row([
          testCell(test),
          dollars(test.costUsd),
          dollars(test.costUsd === undefined ? undefined : test.costUsd / test.runs),
          tokens(test.tokens),
        ]),
      ),
      '',
      '</details>',
    );
  }

  out.push(
    '',
    '<details><summary>Slowest</summary>',
    '',
    row(['Test', 'Median', 'p95']),
    row(['---', '---:', '---:']),
    ...slowest(insights.tests, 5).map((test) => row([testCell(test), duration(test.medianDurationMs), duration(test.p95DurationMs)])),
    '',
    '</details>',
  );
  return out.join('\n') + '\n';
}

function testCell(test: TestInsight): string {
  return `${escape(title(test))}<br>${code(test.file)}`;
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** Escapes what Markdown and the HTML GitHub allows in it would read as markup, and keeps a cell on one line. */
function escape(text: string): string {
  return plain(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|#~@])/g, '\\$1');
}

/** Inline code that a backtick in the value cannot close early. */
function code(text: string): string {
  const value = plain(text).replace(/\|/g, '\\|');
  const fence = value.includes('`') ? '``' : '`';
  return `${fence}${fence.length > 1 ? ' ' : ''}${value}${fence.length > 1 ? ' ' : ''}${fence}`;
}
