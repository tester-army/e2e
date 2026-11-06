/**
 * `e2e explore --parallel` from a config file, on real worker processes: the
 * config builds its own scripted model, so every worker process has it, and
 * the run goes through the built package as a user's does.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExploreOptions, ExploreOutcome } from '../../src/explore/index.ts';
import type { RunEvent } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

// The worker processes load the built package, so the exploration runs from the build too.
const builtExploreModule = '../../dist/explore/index.js';
const { explore: exploreBuilt } = (await import(builtExploreModule)) as typeof import('../../src/explore/index.ts');

/** The finding each scripted explorer reports on the home page. */
const COUNTER_FINDING = {
  title: 'Counter starts at 0 with no label of what it counts',
  kind: 'issue',
  severity: 3,
  expected: 'The counter says what it counts',
  actual: 'output "Counter" reads 0',
  reproduction: ['Open the home page', 'Look at the counter next to Increment'],
};

describe('e2e explore --parallel with a config file', () => {
  type Mode = 'barrier' | 'hang' | 'crash';
  /**
   * A model the config file builds itself, so each worker process has it.
   * The planner plans one step, then finishes; the merge groups every
   * finding. An explorer's step, by mode:
   * - `barrier`: records its worker's pid, waits until both explorers have
   *   arrived (failing after 30s, so explorers that run one after another
   *   fail), then reports the counter finding and completes;
   * - `hang`: observes forever, so only an interrupt ends it;
   * - `crash`: explorer 2's worker kills itself; explorer 1 runs as `barrier`
   *   would, without waiting.
   */
  const configSource = (url: string, mode: Mode) => `import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { web } from '@e2e-dev/web';
const MODE = ${JSON.stringify(mode)};
const BARRIER = path.join(process.cwd(), '.barrier');
const finding = ${JSON.stringify(COUNTER_FINDING)};
let calls = 0;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 }, totalTokens: 120 };
const answer = (content, reason) => ({ content, finishReason: { unified: reason, raw: reason }, usage, warnings: [] });
const text = (value) => answer([{ type: 'text', text: JSON.stringify(value) }], 'stop');
const tool = (toolName, input) => answer([{ type: 'tool-call', toolCallId: 'call-' + (calls += 1), toolName, input: JSON.stringify(input) }], 'tool-calls');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function barrier() {
  mkdirSync(BARRIER, { recursive: true });
  writeFileSync(path.join(BARRIER, String(process.pid)), '');
  for (const started = Date.now(); readdirSync(BARRIER).length < 2; await sleep(50)) {
    if (Date.now() - started > 30_000) throw new Error('the other explorer never arrived: explorers did not run at the same time');
  }
}
const model = {
  specificationVersion: 'v4',
  provider: 'fake',
  modelId: 'scripted-parallel',
  supportedUrls: {},
  async doStream() { throw new Error('scripted models do not stream'); },
  async doGenerate(request) {
    const prompt = JSON.stringify(request.prompt);
    if (request.tools?.some((entry) => entry.name === 'complete_step')) {
      if (MODE === 'hang') {
        await sleep(200);
        return tool('observe', {});
      }
      if (request.prompt.some((message) => message.role === 'tool')) return tool('complete_step', { status: 'passed', summary: 'Looked' });
      if (MODE === 'crash' && prompt.includes('Focus: input and validation')) process.kill(process.pid, 'SIGKILL');
      if (MODE === 'barrier') await barrier();
      return tool('report_finding', finding);
    }
    if (request.responseFormat?.name === 'explore-merge') return text({ groups: [[0, 1]] });
    return text({
      found: true,
      missing: null,
      value: prompt.includes('(none yet')
        ? { decision: 'step', title: 'Counter', instruction: 'Look at the counter', summary: '' }
        : { decision: 'finish', title: '', instruction: '', summary: 'One defect on the home page.' },
    });
  },
};
export default {
  targets: [{ name: 'web', engine: web(), app: { url: ${JSON.stringify(url)} } }],
  agents: { default: { model } },
  actionTimeout: 10_000,
};
`;
  let app: FixtureApp;
  const projects: FixtureProject[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    for (const fixture of projects.splice(0)) fixture.cleanup();
    await app?.close();
  });

  /** Explores a fresh project whose config scripts `mode`, through the built package, as a config file on disk. */
  function exploreFile(mode: Mode, options: Partial<ExploreOptions> = {}): Promise<ExploreOutcome> & { readonly dir: string } {
    const fixture = createProject({ 'e2e.config.ts': configSource(app.url, mode) });
    projects.push(fixture);
    const run = exploreBuilt({
      cwd: fixture.dir,
      goal: 'Explore the home page and find bugs',
      parallel: 2,
      maxSteps: 1,
      timeoutMs: 180_000,
      quiet: true,
      ...options,
    });
    return Object.assign(run, { dir: fixture.dir });
  }

  it('runs the explorers at the same time, each in a worker process of its own, relays their progress, and merges the findings', async () => {
    const events: RunEvent[] = [];
    const notices: string[] = [];
    const run = exploreFile('barrier', { notice: (message) => notices.push(message), onEvent: (event) => { events.push(event); } });
    const outcome = await run;

    expect(outcome.report.run.errors).toEqual([]);
    assertValidReport(outcome.report);
    expect(notices).toEqual([]);
    // Both explorers waited at the barrier for each other, from two worker processes.
    const pids = readdirSync(path.join(run.dir, '.barrier')).map(Number);
    expect(new Set(pids).size).toBe(2);
    expect(pids).not.toContain(process.pid);
    expect(outcome.report.run.results.map((result) => [result.file, result.status])).toEqual([
      ['explore/1', 'failed'],
      ['explore/2', 'failed'],
    ]);
    const started = events.flatMap((event) => (event.type === 'explore' && event.progress.phase === 'started' ? [[event.explorer, event.progress.focus]] : []));
    expect(started.toSorted()).toEqual([[1, 'wrong results'], [2, 'input and validation']]);
    expect(outcome.explore.steps.map((step) => step.explorer).toSorted()).toEqual([1, 2]);
    expect(outcome.explore.findings).toHaveLength(1);
    expect(outcome.explore.findings[0]).toMatchObject({ title: COUNTER_FINDING.title, merged: [{ id: expect.any(String), title: COUNTER_FINDING.title }] });
    expect(outcome.explore.merge).toMatchObject({ status: 'merged', reported: 2, model: { calls: 1, inputTokens: 100, outputTokens: 20 } });
    // The evidence screenshot the worker kept is an artifact of its explorer's test.
    const finding = outcome.explore.findings[0]!;
    const result = outcome.report.run.results.find((entry) => entry.file === `explore/${String(finding.explorer)}`)!;
    expect(result.attempts[0]!.artifacts.find((artifact) => artifact.id === finding.artifactId)).toMatchObject({ kind: 'screenshot' });
  }, 180_000);

  it('interrupts both workers mid-step, cleans up, and records both explorers as cut short with nothing merged', async () => {
    const controller = new AbortController();
    const running = new Set<number>();
    const outcome = await exploreFile('hang', {
      interruptSignal: controller.signal,
      onEvent: (event) => {
        if (event.type !== 'explore' || event.progress.phase !== 'step-started' || event.explorer === undefined) return;
        running.add(event.explorer);
        if (running.size === 2) controller.abort();
      },
    });

    expect(outcome.exitCode).toBe(130);
    expect(outcome.status).toBe('interrupted');
    expect(outcome.report.run.results.map((result) => [result.file, result.status])).toEqual([
      ['explore/1', 'interrupted'],
      ['explore/2', 'interrupted'],
    ]);
    expect(outcome.report.run.results.map((result) => result.attempts[0]?.cleanup)).toEqual(['complete', 'complete']);
    expect(outcome.explore.explorers?.map((explorer) => explorer.ended)).toEqual(['aborted', 'aborted']);
    expect(outcome.explore.merge).toBeUndefined();
    assertValidReport(outcome.report);
  }, 180_000);

  it('fails only the explorer whose worker crashed, keeping what it relayed and the other explorer\'s record', async () => {
    const events: RunEvent[] = [];
    const outcome = await exploreFile('crash', { onEvent: (event) => { events.push(event); } });

    const results = new Map(outcome.report.run.results.map((result) => [result.file, result]));
    expect(results.get('explore/1')?.status).toBe('failed');
    expect(results.get('explore/1')?.attempts[0]?.error?.code).toBe('ASSERTION_FAILED');
    expect(results.get('explore/2')?.status).toBe('failed');
    expect(results.get('explore/2')?.attempts[0]?.error?.code).toBe('WORKER_CRASH');
    // Explorer 2 told the runner it started and planned before its process died.
    const relayed = events.flatMap((event) => (event.type === 'explore' && event.explorer === 2 ? [event.progress.phase] : []));
    expect(relayed).toEqual(expect.arrayContaining(['started', 'step-started']));
    expect(outcome.explore.explorers).toEqual([
      { index: 1, focus: 'wrong results', ended: 'step-limit', summary: 'One defect on the home page.' },
      { index: 2, focus: 'input and validation', ended: 'aborted' },
    ]);
    expect(outcome.explore.findings.map((finding) => finding.explorer)).toEqual([1]);
    expect(outcome.explore.merge).toBeUndefined();
    assertValidReport(outcome.report);
  }, 180_000);
});
