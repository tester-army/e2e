// Compares e2e report.json files from several runs of the agentic suite: per test status, wall time, model calls, tokens.
// Usage: node scripts/compare-reports.mjs jev=/path/a.json default=/path/b.json   (EXPLAIN=1 lists non-passing agent steps)
import { readFileSync } from 'node:fs';

const arms = process.argv.slice(2).map((arg) => {
  const [name, file] = arg.split('=');
  const run = JSON.parse(readFileSync(file, 'utf8')).run;
  const tests = new Map();
  for (const result of run.results) {
    const attempt = result.attempts.at(-1);
    let calls = 0, tokens = 0, cost = 0, agentMs = 0, steps = 0, actions = 0;
    for (const step of attempt?.steps ?? []) {
      if (step.kind !== 'agent') continue;
      steps += 1;
      calls += step.metrics?.modelCalls ?? 0;
      actions += step.metrics?.actionSteps ?? 0;
      agentMs += step.durationMs ?? 0;
      for (const event of step.events ?? []) {
        if (event.kind === 'model') {
          tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
          cost += event.estimatedCostUsd ?? 0;
        }
      }
    }
    const title = result.titlePath.join(' > ');
    tests.set(title, { status: result.status, ms: attempt?.durationMs ?? 0, agentMs, calls, tokens, cost, steps, actions,
      explanations: (attempt?.steps ?? []).filter((s) => s.kind === 'agent' && s.status !== 'passed').map((s) => `${s.api} "${s.label.slice(0, 60)}": ${s.status} — ${s.explanation ?? ''}`) });
  }
  return { name, run, tests };
});

const titles = [...new Set(arms.flatMap((arm) => [...arm.tests.keys()]))];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('test', 62) + arms.map((a) => pad(a.name, 34)).join(''));
for (const title of titles) {
  const cells = arms.map((arm) => {
    const t = arm.tests.get(title);
    if (!t) return pad('-', 34);
    return pad(`${t.status.padEnd(7)} ${(t.ms / 1000).toFixed(1)}s ${t.calls}c ${(t.tokens/1000).toFixed(0)}k`, 34);
  });
  console.log(pad(title.slice(0, 60), 62) + cells.join(''));
}
console.log('');
for (const arm of arms) {
  const ts = [...arm.tests.values()].filter((t) => t.status !== 'skipped');
  const passed = ts.filter((t) => t.status === 'passed').length;
  const sum = (k) => ts.reduce((a, t) => a + t[k], 0);
  console.log(`${arm.name}: ${passed}/${ts.length} passed · wall ${(sum('ms') / 1000).toFixed(0)}s · agent steps ${sum('steps')} · model calls ${sum('calls')} · tokens ${sum('tokens')} · run $${(arm.run.usage?.estimatedCostUsd ?? 0).toFixed(4)} · run ${(new Date(arm.run.finishedAt) - new Date(arm.run.startedAt)) / 1000}s`);
}
if (process.env.EXPLAIN) {
  for (const arm of arms) {
    console.log(`\n== ${arm.name} non-passing agent steps`);
    for (const [title, t] of arm.tests) for (const e of t.explanations) console.log(`- ${title.slice(0, 50)} :: ${e}`);
  }
}
