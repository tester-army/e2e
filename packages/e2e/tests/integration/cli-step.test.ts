/**
 * `e2e run --step` without a terminal, through the built CLI on the fake
 * engine: the run goes on in a background process, and later commands from
 * the same directory drive it, each answering with how the steps since the
 * last one ended, then the held step and the screen it waits on.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stepAddress } from '../../src/cli/step-control.ts';
import { createProject, workerFakeConfigSource, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

const SUITE = `import { test } from 'e2e';

test('opens three pages', async ({ app }) => {
  await app.open('/one');
  await app.open('/two');
  await app.open('/three');
});
`;

/** A project whose one test has three steps, or the given suite and config; stopped and removed after the test. */
function project(suite = SUITE, config = workerFakeConfigSource(1)): FixtureProject {
  const created = createProject({ 'e2e.config.ts': config, 'tests/pages.e2e.ts': suite });
  projects.push(created);
  return created;
}

/** One CLI command in `dir`, with no terminal on any end. */
function e2e(dir: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, CI: '', NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Waits until the log of the stepped run going in `dir` shows `text`: a command acted, whatever the machine's load. */
async function logShows(dir: string, text: string): Promise<void> {
  // The log is `<id>-<pid>.log`, one per starting command.
  const { log } = stepAddress(dir);
  const folder = path.dirname(log);
  const id = path.basename(log).replace(/-\d+\.log$/, '');
  for (let tries = 0; tries < 600; tries += 1) {
    const logs = fs.readdirSync(folder).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.log'));
    if (logs.some((name) => fs.readFileSync(path.join(folder, name), 'utf8').includes(text))) return;
    await sleep(50);
  }
  throw new Error(`the stepped run's log never showed ${text}`);
}

/** Starts `e2e run --step next` in `dir` and kills it once step `/two` has run, while it waits. */
async function nextKilledAfterTwo(dir: string): Promise<void> {
  const killed = spawn(process.execPath, [CLI, 'run', '--step', 'next'], { cwd: dir, env: { ...process.env, CI: '', NO_COLOR: '1' }, stdio: 'ignore' });
  await logShows(dir, '✓ app.open "/two"');
  killed.kill('SIGKILL');
}

afterEach(() => {
  for (const created of projects.splice(0)) {
    e2e(created.dir, ['run', '--step', 'stop']);
    created.cleanup();
  }
});

describe('e2e run --step without a terminal', () => {
  it('pauses in the background, answers each command with the next held step and its screen, and runs the rest', () => {
    const { dir } = project();
    const started = e2e(dir, ['run', '--step', '--', 'tests/pages.e2e.ts']);
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toMatch(/✓ app\.open "\/one" \d+ms\nPaused before step 2 of opens three pages \[fake\]:/);
    expect(started.stdout).toContain('app.open "/two" (tests/pages.e2e.ts:5)');
    expect(started.stdout).toContain('button "Submit"');

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain('✓ app.open "/two"');
    expect(next.stdout).toContain('Paused before step 3 of opens three pages [fake]:');
    expect(next.stdout).toContain('app.open "/three"');

    const last = e2e(dir, ['run', '--step', 'rest']);
    expect(last.exitCode).toBe(0);
    expect(last.stdout).toContain('✓ app.open "/three"');
    expect(last.stdout).toContain('1 passed (1)');
    expect(last.stdout).toMatch(/The stepped run has ended\.\n$/);

    const gone = e2e(dir, ['run', '--step', 'next']);
    expect(gone.exitCode).toBe(2);
    expect(gone.stderr).toContain('no stepped run is going in this directory');
  });

  it('prints why a run that cannot start ended', () => {
    const { dir } = project();
    const started = e2e(dir, ['run', 'tests/missing.e2e.ts', '--step']);
    expect(started.exitCode).toBe(2);
    expect(started.stdout).toContain('NO_TESTS');
    expect(started.stdout).toMatch(/The stepped run has ended\.\n$/);
  });

  it('refuses to start over a claim lock a killed run left, and names it', () => {
    const { dir } = project();
    const { lock } = stepAddress(dir);
    fs.writeFileSync(lock, '');
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, minuteAgo, minuteAgo);
    try {
      const started = e2e(dir, ['run', '--step']);
      expect(started.exitCode).toBe(2);
      expect(started.stdout).toContain(`RUNNER_BUSY: ${lock} was left by a stepped run killed while it started`);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  it('refuses a second run and a command with files, and ends the run on stop', () => {
    const { dir } = project();
    expect(e2e(dir, ['run', '--step']).exitCode).toBe(0);

    const second = e2e(dir, ['run', '--step']);
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain('a stepped run is already going in this directory: drive it with e2e run --step next, rest, or stop');

    const withFiles = e2e(dir, ['run', '--step', 'next', 'tests/pages.e2e.ts']);
    expect(withFiles.exitCode).toBe(2);
    expect(withFiles.stderr).toContain('--step next takes no files or other flags');

    const stopped = e2e(dir, ['run', '--step', 'stop']);
    expect(stopped.exitCode).toBe(130);
    expect(stopped.stdout).toContain('1 interrupted');
    expect(e2e(dir, ['run', '--step', 'next']).exitCode).toBe(2);
  });

  it('prints the step a killed command missed, without running it, and says the action was not applied', async () => {
    const { dir } = project(`import { test } from 'e2e';

test('waits between pages', async ({ app }) => {
  await app.open('/one');
  await app.open('/two');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await app.open('/three');
});
`);
    expect(e2e(dir, ['run', '--step']).exitCode).toBe(0);

    // Runs step 2, then dies while the test waits before step 3.
    await nextKilledAfterTwo(dir);
    // Past the test's wait, so step 3 is held with no command waiting.
    await sleep(4_000);

    const missed = e2e(dir, ['run', '--step', 'next']);
    expect(missed.exitCode).toBe(0);
    expect(missed.stdout).toContain('e2e run --step next was not applied: the step below was held while no command waited');
    expect(missed.stdout).toContain('Paused before step 3');
    expect(missed.stdout).not.toContain('✓ app.open "/three"');

    const last = e2e(dir, ['run', '--step', 'next']);
    expect(last.stdout).toContain('✓ app.open "/three"');
    expect(last.stdout).toContain('1 passed (1)');
  });

  it('delivers a long answer before a stopped run exits', async () => {
    const { dir } = project(`import { test } from 'e2e';

test('prints a lot while held', async ({ app }) => {
  await app.open('/one');
  setTimeout(() => {
    for (let line = 0; line < 500; line += 1) console.log(\`\${line} \${'x'.repeat(1_000)}\`);
  }, 1_000);
  await app.open('/two');
});
`);
    expect(e2e(dir, ['run', '--step']).exitCode).toBe(0);
    // The output lands while step 2 is held, after the start's answer.
    await sleep(3_000);
    const stopped = e2e(dir, ['run', '--step', 'stop']);
    expect(stopped.exitCode).toBe(130);
    expect(stopped.stdout).toContain(`499 ${'x'.repeat(1_000)}`);
    expect(stopped.stdout).toMatch(/The stepped run has ended\.\n$/);
  });

  it('prints an agent step once', () => {
    const { dir } = project(
      `import { test } from 'e2e';

test('acts', async ({ app, agent }) => {
  await app.open('/one');
  await agent.act('press the button');
});
`,
      workerFakeConfigSource(1, "\n  agents: { default: { executor: { name: 'own', runStep: async () => ({ status: 'passed', summary: 'done' }) } } },"),
    );
    expect(e2e(dir, ['run', '--step']).exitCode).toBe(0);
    const ran = e2e(dir, ['run', '--step', 'next']);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.split('agent.act "press the button"').length - 1).toBe(1);
  });

  it('keeps the end of a run that ended with no command waiting for the next command', async () => {
    const { dir } = project(`import { test } from 'e2e';

test('waits after the last page', async ({ app }) => {
  await app.open('/one');
  await app.open('/two');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
});
`);
    expect(e2e(dir, ['run', '--step']).exitCode).toBe(0);
    // Runs the last step, then dies while the test finishes.
    await nextKilledAfterTwo(dir);
    // Past the test's wait, so the run has ended with no command waiting.
    await sleep(4_000);

    const end = e2e(dir, ['run', '--step', 'next']);
    expect(end.exitCode).toBe(0);
    expect(end.stdout).toContain('e2e run --step next was not applied: the run had ended.');
    expect(end.stdout).toContain('1 passed (1)');
    expect(end.stdout).toMatch(/The stepped run has ended\.\n$/);
  });

  it('shows a secret on a held screen as its placeholder', () => {
    const { dir } = project(
      SUITE,
      `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const tree = { ref: { id: 'root', revision: '' }, role: 'root', name: '', children: [{ ref: { id: 'label', revision: '' }, role: 'text', name: 'Token held-token-42' }] };

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ tree }).engine, app: FAKE_APP }],
  workers: 1,
  secrets: { apiToken: 'held-token-42' },
} satisfies E2EConfig;
`,
    );
    const started = e2e(dir, ['run', '--step']);
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain('Token <secret:apiToken>');
    expect(started.stdout).not.toContain('held-token-42');
  });
});
