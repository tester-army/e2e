#!/usr/bin/env node
/**
 * Runs one bench config N times and tallies outcomes per test: the only honest
 * measure of run-to-run reliability. Every run's report and AI trace are kept.
 *
 *   AI_GATEWAY_API_KEY=... node bench-repeat.mjs --config e2e.long.config.ts --runs 10 \
 *     --out /tmp/repeat-luna --model openai/gpt-5.6-luna [--cache read-write] [--files tests-bench-long/x.e2e.ts]
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const config = opt('config', 'e2e.long.config.ts');
const runs = Number(opt('runs', '5'));
const out = opt('out', '/tmp/bench-repeat');
const model = opt('model', undefined);
const cache = opt('cache', undefined);
const files = opt('files', undefined);
mkdirSync(out, { recursive: true });

const tally = new Map(); // title -> { passed, failed, failures: [{run, step, message}] }
const totals = [];
for (let run = 1; run <= runs; run += 1) {
  // Only this run's outputs go; the trace cache under .e2e/cache is exactly
  // what a cache-on repeat is measuring.
  for (const stale of ['.e2e/report.json', '.e2e/ai-trace.json', '.e2e/artifacts']) {
    rmSync(stale, { recursive: true, force: true });
  }
  const cli = ['node_modules/e2e/dist/cli/bin.js', 'run', '--config', config, '--ai-trace', '--debug'];
  if (files) cli.push(files);
  if (cache === 'off') cli.push('--no-cache');
  const env = { ...process.env, ...(model ? { E2E_MODEL: model } : {}), ...(cache && cache !== 'off' ? { E2E_CACHE: cache } : {}) };
  const started = Date.now();
  const result = spawnSync(process.execPath, cli, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - started;
  const runDir = path.join(out, `run-${String(run).padStart(2, '0')}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'stdout.log'), result.stdout ?? '');
  writeFileSync(path.join(runDir, 'stderr.log'), result.stderr ?? '');
  if (existsSync('.e2e/report.json')) cpSync('.e2e/report.json', path.join(runDir, 'report.json'));
  if (existsSync('.e2e/ai-trace.json')) cpSync('.e2e/ai-trace.json', path.join(runDir, 'ai-trace.json'));
  if (existsSync('.e2e/artifacts')) cpSync('.e2e/artifacts', path.join(runDir, 'artifacts'), { recursive: true });
  if (!existsSync(path.join(runDir, 'report.json'))) {
    console.log(`run ${run}: no report (exit ${result.status})`);
    continue;
  }
  const report = JSON.parse(readFileSync(path.join(runDir, 'report.json'), 'utf8')).run;
  let calls = 0;
  let cost = 0;
  for (const test of report.results) {
    const title = test.titlePath.at(-1);
    const entry = tally.get(title) ?? { passed: 0, failed: 0, failures: [] };
    const attempt = test.attempts.at(-1);
    for (const step of attempt.steps) {
      if (step.kind === 'agent') {
        calls += step.metrics?.modelCalls ?? 0;
        cost += step.model?.estimatedCostUsd ?? 0;
      }
    }
    if (test.status === 'passed') entry.passed += 1;
    else {
      entry.failed += 1;
      const failing = attempt.steps.find((step) => step.status !== 'passed');
      entry.failures.push({
        run,
        step: failing ? `${failing.api} ${failing.label.slice(0, 70)}` : '(no step)',
        code: attempt.error?.code ?? failing?.error?.code,
        message: (attempt.error?.message ?? failing?.error?.message ?? '').slice(0, 300),
        cached: failing?.cache?.mode,
      });
    }
    tally.set(title, entry);
  }
  totals.push({ run, status: report.status, calls, cost, wallMs });
  console.log(`run ${run}: ${report.status} · ${calls} calls · $${cost.toFixed(3)} · ${(wallMs / 1000).toFixed(0)}s`);
}
console.log('\nPER TEST');
for (const [title, entry] of tally) {
  const total = entry.passed + entry.failed;
  console.log(`${entry.failed === 0 ? '✓' : '✗'} ${title}: ${entry.passed}/${total} passed`);
  for (const failure of entry.failures) {
    console.log(`   run ${failure.run} · ${failure.step} · ${failure.code ?? ''}${failure.cached ? ` · cache=${failure.cached}` : ''}\n      ${failure.message}`);
  }
}
const okRuns = totals.filter((t) => t.status === 'passed').length;
console.log(`\nRUNS ${okRuns}/${totals.length} fully passed · calls ${totals.map((t) => t.calls).join(',')} · total $${totals.reduce((s, t) => s + t.cost, 0).toFixed(2)}`);
writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ totals, tally: [...tally] }, null, 2));
