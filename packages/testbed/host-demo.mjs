/**
 * Embedding-host demo: tests defined as DATA (a hosted platform's DB-row
 * shape — natural-language steps, no test file authored by a human),
 * materialized into a suite and executed in-process through `@e2edev/e2e/run` with
 * `rawConfig` (one run per worker process, the hosted shape). Events stream
 * as they happen; artifacts are enumerated at test-finished (the upload
 * seam); the second invocation replays recorded acts zero-turn.
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed run demo:host
 *
 * (`demo:host` builds the bench app first; running this file directly needs
 * a prior `pnpm run bench:build`.)
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { playwright } from '@e2edev/playwright';
import { run } from '@e2edev/e2e/run';

// ---- 1. The "DB rows": how a hosted platform stores a test ----------------
// A step is data: a kind, an instruction, and optionally the name of a
// configured credential to hand the agent. Nothing here is code.
const testRow = {
  title: 'member can sign in and reach the dashboard',
  steps: [
    { type: 'act', title: 'sign in with the given credentials', credential: 'member' },
    { type: 'assert', title: 'the dashboard shows a welcome greeting for the signed-in user' },
  ],
};

// ---- 2. Materialize the row into a suite ----------------------------------
function stepSource(step) {
  const title = JSON.stringify(step.title);
  if (step.type === 'assert') return `  await agent.assert(${title});`;
  const params =
    step.credential === undefined
      ? ''
      : `, { credential: credentials.user(${JSON.stringify(step.credential)}) }`;
  return `  await agent.act(${title}${params});`;
}

const dir = path.join(import.meta.dirname, 'tmp-host-demo');
rmSync(path.join(dir, 'tests'), { recursive: true, force: true });
mkdirSync(path.join(dir, 'tests'), { recursive: true });
writeFileSync(
  path.join(dir, 'tests', 'row.e2e.ts'),
  `import { test, credentials } from '@e2edev/e2e';\n\ntest(${JSON.stringify(testRow.title)}, async ({ web, agent }) => {\n  await web.goto('/login');\n${testRow.steps.map(stepSource).join('\n')}\n});\n`,
);

// ---- 3. Host-owned app process (the platform owns the target, not e2e) ----
// Detached so the whole group can be killed: pnpm does not reliably forward
// signals to the `next start` child, and an orphan on :4273 would serve later
// runs from a stale process (same reason the runner's AppProcess kills the
// group).
const server = spawn('pnpm', ['run', 'bench:serve'], {
  cwd: import.meta.dirname,
  stdio: 'ignore',
  detached: true,
});
try {
  for (let tries = 0; ; tries += 1) {
    if (tries > 60) throw new Error('bench app did not come up');
    try {
      const response = await fetch('http://localhost:4273/login');
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    await delay(500);
  }

  // ---- 4. Run in-process: rawConfig, provider credential, live events -----
  const counts = new Map();
  let lastSeq = 0;
  let ordered = true;
  const outcome = await run({
    cwd: dir,
    quiet: true,
    rawConfig: {
      projectId: 'host-demo',
      app: { url: 'http://localhost:4273' },
      tests: 'tests/**/*.e2e.ts',
      // The platform is explicit since the backend contract (RFC0002): a host
      // declares the target and the backend that drives it, same as a config.
      targets: [{ name: 'web', platform: 'web', backend: playwright() }],
      // Same budgets as the bench config: model turns on a busy gateway can
      // run tens of seconds, and a hosted platform sets its own ceilings.
      timeout: 300_000,
      actionTimeout: 90_000,
      agent: { model: process.env.E2E_MODEL ?? 'google/gemini-3-flash' },
      cache: 'read-write',
      credentials: {
        member: { username: 'member', password: () => Promise.resolve('bench-password-1') },
      },
    },
    env: process.env,
    onEvent: (event) => {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      ordered &&= event.seq > lastSeq;
      lastSeq = event.seq;
      if (event.type === 'step' && event.progress.phase === 'event' && event.progress.event.detail) {
        console.log(`  [action] ${event.progress.event.detail}`);
      }
      if (event.type === 'step' && event.progress.phase === 'end') {
        const p = event.progress;
        console.log(`[step] ${p.api} ${JSON.stringify(p.label)} ${p.status} ${p.durationMs}ms (${p.modelCalls} model calls)`);
      }
      if (event.type === 'test-finished') {
        console.log(`[test] ${event.result.test.title}: ${event.result.status}`);
        for (const attempt of event.result.attempts) {
          for (const artifact of attempt.artifacts) {
            console.log(`  [artifact->store] ${artifact.kind} ${artifact.path} sha256=${(artifact.sha256 ?? '').slice(0, 12)}…`);
          }
        }
      }
    },
  });

  console.log(`\nrun ${outcome.status} exit=${outcome.exitCode} cost=$${outcome.report.run.usage.estimatedCostUsd ?? 0}`);
  console.log('events:', JSON.stringify(Object.fromEntries(counts)), '· seq strictly increasing:', ordered);
  let entries = 0;
  try {
    entries = readdirSync(path.join(dir, '.e2e', 'cache')).length;
  } catch {
    // no entry written yet (a failed attempt confirms nothing)
  }
  console.log('trace cache entries:', entries);
} finally {
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid);
    } catch {
      server.kill();
    }
  }
}
