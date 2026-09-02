/**
 * Asserts that a second run of a device suite replayed every passed
 * `agent.act` step from the trace cache with zero model calls. Reads the JSON
 * report the run just wrote; exits 1 with the offending steps otherwise.
 *
 * Usage: node scripts/assert-cache-replay.mjs [path/to/report.json]
 */

import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? '.e2e/report.json';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const offenders = [];
let replayed = 0;
for (const result of report.run.results) {
  const attempt = result.attempts.at(-1);
  if (attempt === undefined) continue;
  for (const step of attempt.steps ?? []) {
    if (step.kind !== 'agent' || step.api !== 'agent.act' || step.status !== 'passed') continue;
    const title = result.titlePath.join(' > ');
    const calls = step.metrics?.modelCalls ?? step.model?.calls ?? null;
    if (step.cache?.mode !== 'self-finalized' || (calls !== null && calls !== 0)) {
      offenders.push(`${title}: ${step.label} -> ${JSON.stringify(step.cache)} modelCalls=${calls}`);
      continue;
    }
    replayed += 1;
  }
}

if (offenders.length > 0) {
  console.error('agent.act steps that did not replay from the trace cache:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`trace cache: ${replayed} agent.act step(s) replayed with zero model calls`);
