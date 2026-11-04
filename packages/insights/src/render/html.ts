import type { Insights, Outcome, TestInsight } from '../analyze.ts';
import { cacheHotspots, costliest, dollars, duration, outcomeLine, percent, plain, rateCell, reasonsLine, slowest, title, tokens, UNHEALTHY, when, where } from './format.ts';

const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'passed',
  retry: 'passed on retry',
  fail: 'failed',
  infra: 'infrastructure failure',
};

/**
 * The analysis as one self-contained HTML page: no script, no network, no
 * external font, so it opens from a CI artifact as it does from disk. Every
 * value from the history is HTML-escaped.
 */
export function renderHtml(insights: Insights): string {
  const unhealthy = insights.tests.filter((test) => UNHEALTHY.has(test.verdict));
  const body =
    insights.runs === 0
      ? '<p class="empty">No runs in the history yet. Add <code>insights()</code> to <code>reporters</code> and run e2e.</p>'
      : [
          tiles(insights),
          section(
            'Broken, failing, and flaky',
            unhealthy.length === 0
              ? `<p class="empty">No broken, failing, or flaky tests across the last ${insights.runs} runs.</p>`
              : testTable(unhealthy, insights.runs),
          ),
          hotspotsSection(insights.tests),
          costSection(insights.tests),
          section(
            'Slowest',
            table(
              ['Test', 'Median', 'p95'],
              slowest(insights.tests, 10).map((test) => [testCell(test), esc(duration(test.medianDurationMs)), esc(duration(test.p95DurationMs))]),
              [false, true, true],
            ),
          ),
          section('All tests', testTable(insights.tests, insights.runs)),
        ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>e2e insights</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>e2e insights</h1>
${insights.runs === 0 ? '' : `<p class="period">${insights.runs} runs · ${esc(when(insights.from))} → ${esc(when(insights.to))}</p>`}
</header>
${body}
</main>
</body>
</html>
`;
}

function tiles(insights: Insights): string {
  const tile = (label: string, value: string, tone = ''): string =>
    `<div class="tile ${tone}"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;
  return `<section class="tiles">
${tile('Runs passed', `${insights.passedRuns} / ${insights.runs}`)}
${tile('Broken', String(insights.counts.broken), insights.counts.broken > 0 ? 'bad' : '')}
${tile('Failing', String(insights.counts.failing), insights.counts.failing > 0 ? 'bad' : '')}
${tile('Flaky', String(insights.counts.flaky), insights.counts.flaky > 0 ? 'warn' : '')}
${tile('Stable', String(insights.counts.stable))}
${insights.cache.steps > 0 ? tile('Cache replayed', percent(insights.cache.replayed, insights.cache.steps)) : ''}
${insights.modelTokens > 0 || insights.costUsd !== undefined ? tile('Model cost', dollars(insights.costUsd)) : ''}
</section>`;
}

function testTable(tests: readonly TestInsight[], runs: number): string {
  return table(
    ['Verdict', 'Test', `Last ${runs} runs`, 'Flake rate', 'Results', 'Same-commit flips', 'Top error'],
    tests.map((test) => [
      `<span class="verdict ${test.verdict}">${test.verdict}</span>`,
      testCell(test),
      strip(test.timeline),
      esc(rateCell(test)),
      esc(outcomeLine(test)),
      String(test.sameCommitFlips),
      test.topErrorCode ? `<code>${esc(test.topErrorCode)}</code>` : '-',
    ]),
    [false, false, false, true, false, true, false],
  );
}

function hotspotsSection(tests: readonly TestInsight[]): string {
  const hotspots = cacheHotspots(tests, 15);
  if (hotspots.length === 0) return '';
  return section(
    'Replay cache misses',
    table(
      ['Test', 'Replayed', 'Missed + handed off', 'Model calls', 'Why'],
      hotspots.map((test) => [
        testCell(test),
        esc(percent(test.cache.replayed, test.cache.steps)),
        String(test.cache.missed + test.cache.handedOff),
        String(test.modelCalls),
        esc(reasonsLine(test.cache) || '-'),
      ]),
      [false, true, true, true, false],
    ),
  );
}

function costSection(tests: readonly TestInsight[]): string {
  const expensive = costliest(tests, 15);
  if (expensive.length === 0) return '';
  return section(
    'Model cost',
    table(
      ['Test', 'Cost', 'Per run', 'Tokens', 'Model calls'],
      expensive.map((test) => [
        testCell(test),
        esc(dollars(test.costUsd)),
        esc(dollars(test.costUsd === undefined ? undefined : test.costUsd / test.runs)),
        esc(tokens(test.tokens)),
        String(test.modelCalls),
      ]),
      [false, true, true, true, true],
    ),
  );
}

/** One square per result, oldest first, each titled with its outcome for a screen reader and a hover. */
function strip(timeline: readonly Outcome[]): string {
  const cells = timeline.map((outcome) => `<i class="o ${outcome}" title="${OUTCOME_LABEL[outcome]}"></i>`).join('');
  const summary = timeline.map((outcome) => OUTCOME_LABEL[outcome]).join(', ');
  return `<span class="strip" role="img" aria-label="${esc(summary)}">${cells}</span>`;
}

function testCell(test: TestInsight): string {
  return `<span class="title">${esc(title(test))}</span><span class="meta">${esc(plain(test.file))} · ${esc(where(test))}</span>`;
}

function section(heading: string, content: string): string {
  return `<section><h2>${esc(heading)}</h2>${content}</section>`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[], numeric: readonly boolean[]): string {
  const cls = (column: number): string => (numeric[column] ? ' class="num"' : '');
  return `<div class="scroll"><table>
<thead><tr>${header.map((cell, column) => `<th${cls(column)}>${esc(cell)}</th>`).join('')}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${row.map((cell, column) => `<td${cls(column)}>${cell}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table></div>`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#fafaf9;--surface:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--pass:#16a34a;--retry:#d97706;--fail:#dc2626;--infra:#a8a29e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--surface:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--line:#292524;--pass:#22c55e;--retry:#f59e0b;--fail:#ef4444;--infra:#57534e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0}
h2{font-size:16px;margin:32px 0 12px}
.period{color:var(--muted);margin:4px 0 0}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:24px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.tile .label{color:var(--muted);font-size:12px}
.tile .value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.tile.bad .value{color:var(--fail)}
.tile.warn .value{color:var(--retry)}
.scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:12px;font-weight:500;color:var(--muted);white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.title{display:block;font-weight:500}
.meta{display:block;color:var(--muted);font-size:12px}
.verdict{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.verdict.broken,.verdict.failing{color:var(--fail);border-color:var(--fail)}
.verdict.flaky{color:var(--retry);border-color:var(--retry)}
.verdict.new,.verdict.stable{color:var(--muted)}
.strip{display:inline-flex;gap:2px;flex-wrap:wrap;max-width:260px}
.o{display:inline-block;width:8px;height:16px;border-radius:2px}
.o.pass{background:var(--pass)}.o.retry{background:var(--retry)}.o.fail{background:var(--fail)}.o.infra{background:var(--infra)}
.empty{color:var(--muted)}
`;
