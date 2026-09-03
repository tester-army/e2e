#!/usr/bin/env node
/**
 * Compares two e2e report.json files from the agent benchmarks, step by step.
 * Usage: node bench-compare.mjs <baseline report.json> <candidate report.json>
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: bench-compare.mjs <baseline.json> <candidate.json>');
  process.exit(2);
}
const summary = fileURLToPath(new URL('./bench-summary.mjs', import.meta.url));
const load = (file) => JSON.parse(execFileSync(process.execPath, [summary, file, '--json'], { encoding: 'utf8' }));
const A = load(a);
const B = load(b);
const pct = (x, y) => (x === 0 ? '   -  ' : `${((y / x - 1) * 100).toFixed(0).padStart(4)}%`);
const pad = (v, n) => String(v).padStart(n);
console.log(`${'step'.padEnd(62)} ${'calls'.padStart(11)} ${'input tokens'.padStart(19)} ${'cost'.padStart(19)} ${'model s'.padStart(13)}`);
for (const testA of A.tests) {
  const testB = B.tests.find((t) => t.title === testA.title);
  if (!testB) continue;
  console.log(`${testA.status === 'passed' ? '✓' : '✗'}→${testB.status === 'passed' ? '✓' : '✗'} ${testA.title}`);
  testA.steps.forEach((sa, index) => {
    const sb = testB.steps[index];
    if (!sb) return;
    console.log(
      `   ${JSON.stringify(sa.label).slice(0, 58).padEnd(60)} ${pad(sa.calls, 3)}→${pad(sb.calls, 3)} ${pct(sa.calls, sb.calls)} ${pad(sa.input, 7)}→${pad(sb.input, 7)} ${pct(sa.input, sb.input)} $${sa.cost.toFixed(3)}→$${sb.cost.toFixed(3)} ${pct(sa.cost, sb.cost)} ${pad((sa.modelMs / 1000).toFixed(0), 4)}→${pad((sb.modelMs / 1000).toFixed(0), 4)}`,
    );
  });
}
const ta = A.totals;
const tb = B.totals;
console.log(
  `\nTOTAL passed ${ta.passed}/${ta.tests}→${tb.passed}/${tb.tests} · calls ${ta.calls}→${tb.calls} (${pct(ta.calls, tb.calls).trim()}) · in ${ta.input}→${tb.input} (${pct(ta.input, tb.input).trim()}) · out ${ta.output}→${tb.output} · $${ta.cost.toFixed(3)}→$${tb.cost.toFixed(3)} (${pct(ta.cost, tb.cost).trim()}) · model ${(ta.modelMs / 1000).toFixed(0)}s→${(tb.modelMs / 1000).toFixed(0)}s · wall ${(ta.wallMs / 1000).toFixed(0)}s→${(tb.wallMs / 1000).toFixed(0)}s`,
);
