#!/usr/bin/env node
/**
 * Summarizes one e2e report.json for the agent benchmarks: per test status and
 * time, per agent step calls / tokens / cost, and suite totals. Usage:
 *   node bench-summary.mjs <report.json> [--json]
 */
import { readFileSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: bench-summary.mjs <report.json> [--json]');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const doc = report.run ?? report.report ?? report;
const totals = { tests: 0, passed: 0, steps: 0, calls: 0, input: 0, output: 0, cost: 0, wallMs: 0, modelMs: 0 };
const tests = [];
for (const result of doc.results ?? []) {
  const attempt = result.attempts?.at(-1) ?? result;
  const steps = (attempt.steps ?? []).filter((step) => step.kind === 'agent');
  const row = { title: result.title ?? result.name ?? (result.titlePath ?? []).join(' › '), status: result.status, durationMs: attempt.durationMs ?? result.durationMs ?? 0, steps: [] };
  totals.tests += 1;
  if (result.status === 'passed') totals.passed += 1;
  totals.wallMs += row.durationMs;
  for (const step of steps) {
    const model = step.model ?? {};
    const metrics = step.metrics ?? {};
    const modelMs = (step.events ?? []).filter((e) => e.kind === 'model').reduce((s, e) => s + (e.durationMs ?? 0), 0);
    const entry = {
      api: step.api,
      label: step.label,
      status: step.status,
      durationMs: step.durationMs,
      modelMs,
      calls: model.calls ?? metrics.modelCalls ?? 0,
      actions: metrics.actionSteps ?? 0,
      input: model.inputTokens ?? 0,
      output: model.outputTokens ?? 0,
      peak: model.peakTokensPerCall ?? 0,
      cost: model.estimatedCostUsd ?? 0,
      error: step.error?.code,
    };
    row.steps.push(entry);
    totals.steps += 1;
    totals.calls += entry.calls;
    totals.input += entry.input;
    totals.output += entry.output;
    totals.cost += entry.cost;
    totals.modelMs += modelMs;
  }
  tests.push(row);
}
if (flags.includes('--json')) {
  console.log(JSON.stringify({ totals, tests }, null, 2));
} else {
  const pad = (v, n) => String(v).padStart(n);
  for (const t of tests) {
    console.log(`${t.status === 'passed' ? '✓' : '✗'} ${t.title} (${(t.durationMs / 1000).toFixed(1)}s)`);
    for (const s of t.steps) {
      console.log(
        `   ${s.status === 'passed' ? ' ' : '!'} ${s.api} ${JSON.stringify(s.label).slice(0, 58).padEnd(60)} calls ${pad(s.calls, 2)} acts ${pad(s.actions, 2)} in ${pad(s.input, 6)} out ${pad(s.output, 5)} peak ${pad(s.peak, 6)} $${s.cost.toFixed(4)} ${(s.modelMs / 1000).toFixed(0)}s${s.error ? ' ' + s.error : ''}`,
      );
    }
  }
  console.log(
    `\nTOTAL tests ${totals.passed}/${totals.tests} passed · steps ${totals.steps} · calls ${totals.calls} · in ${totals.input} · out ${totals.output} · $${totals.cost.toFixed(4)} · model ${(totals.modelMs / 1000).toFixed(0)}s · wall ${(totals.wallMs / 1000).toFixed(0)}s`,
  );
}
