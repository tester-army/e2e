/**
 * Playwright vs WebDriver BiDi: the same scenarios on both drivers of the
 * built `web()` engine, through the engine-contract hooks the runner and the
 * agent loop call (`init`, `startAttempt`, `session.open`, `observe`,
 * `locate`, `perform`, `artifacts.screenshot`). Serves the testbed app and a
 * synthetic heavy page itself, so nothing leaves the machine.
 *
 * Drivers run interleaved, in alternating order, so a drift of the machine
 * over the run lands on both; each scenario's BiDi/Playwright ratio carries a
 * bootstrap 95% interval, and the observations both drivers made of the same
 * pages are compared, so the timings are of equal work.
 *
 *   pnpm build
 *   node packages/web/bench/bidi.ts [--iterations 20] [--browsers chromium,firefox] [--testbed-runs 3] [--out bidi-results.json]
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { EngineHandle, LocatorExpression, NodeRef, OperationContext, SemanticNode } from 'e2e/engine';
import { web } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    iterations: { type: 'string', default: '20' },
    'cold-iterations': { type: 'string', default: '10' },
    browsers: { type: 'string', default: 'chromium,firefox' },
    drivers: { type: 'string', default: 'playwright,bidi' },
    'testbed-runs': { type: 'string', default: '3' },
    'steps-per-test': { type: 'string', default: '6' },
    out: { type: 'string', default: path.join(path.dirname(fileURLToPath(import.meta.url)), 'bidi-results.json') },
  },
});
const ITERATIONS = Number(values.iterations);
const COLD_ITERATIONS = Number(values['cold-iterations']);
const BROWSERS = values.browsers.split(',') as ('chromium' | 'firefox')[];
const DRIVERS = values.drivers.split(',') as ('playwright' | 'bidi')[];
const TESTBED_RUNS = Number(values['testbed-runs']);
/** Steps of a typical test: the testbed's mean is 6.25 per test (79 tests, `.e2e/report.json`), median 5. */
const STEPS_PER_TEST = Number(values['steps-per-test']);
/**
 * Testbed tests a driver cannot pass on Firefox, left out of both drivers' wall-clock runs there so
 * neither pays a failing test's timeout: HTML5 drag and drop and media emulation on BiDi
 * (upstream Firefox gaps), and the pad drag that fails on Playwright's Firefox on main too.
 */
const FIREFOX_SKIPS = 'drags and drops on the board|dragging the card marks it done|emulated media reaches|raw mouse input drags along the pad';
/**
 * Actions in the agent flow, each with the observation before it (the flow's
 * eighth observation checks the result): an agent step is the flow, less its
 * one navigation, over these.
 */
const AGENT_FLOW_ACTIONS = 7;
/** Warm iterations a driver runs before the other takes its turn. */
const BLOCK = 5;
const TESTBED_PORT = 4291;
const HEAVY_PORT = 4292;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A page of 1,500 table rows, each with a checkbox, a text field, and a button: ~9k elements, an admin-grid-sized DOM. */
function heavyPage(): string {
  const rows = Array.from({ length: 1500 }, (_, index) =>
    `<tr><td><input type="checkbox" aria-label="Select row ${index}"></td><td>Customer ${index}</td><td>customer${index}@example.com</td>` +
    `<td><input aria-label="Note ${index}" placeholder="Note"></td><td><button>Open ${index}</button></td></tr>`,
  ).join('');
  return `<!doctype html><title>Heavy</title><main><h1>Customers</h1><label>Search <input placeholder="Search customers"></label>` +
    `<button id="go">Search</button><output role="status" aria-label="Result"></output><table><tbody>${rows}</tbody></table></main>` +
    `<script>document.getElementById('go').onclick = () => { document.querySelector('output').textContent = 'searched ' + document.querySelector('input[placeholder="Search customers"]').value; };</script>`;
}

/** Starts `server` on `port` of the loopback interface. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

/** Resolves once `url` answers with a success status, failing after ten seconds. */
async function waitForHttp(url: string): Promise<void> {
  for (let poll = 0; poll < 100; poll += 1) {
    if (await fetch(url).then((response) => response.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} never answered`);
}

/** A fresh operation budget for one engine call. */
const operation = (timeoutMs = 30_000): OperationContext => ({ signal: AbortSignal.timeout(timeoutMs), timeoutMs });

/** A string text pattern. */
const string = (value: string, exact = false) => ({ kind: 'string' as const, value, exact });
/** A role query, with an optional accessible name. */
const role = (value: string, name?: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: string(value, true), ...(name === undefined ? {} : { name: string(name) }) },
});
/** An exact label query. */
const label = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'label', value: string(value, true) } });

/** One engine with an attempt running, and the hooks the scenarios call. */
interface Driven {
  readonly engine: EngineHandle;
  open(url: string): Promise<void>;
  locateOne(expression: LocatorExpression): Promise<NodeRef>;
  close(): Promise<void>;
}

/** A fresh `web()` engine on `driver` and `browser`. */
function engineFor(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox'): EngineHandle {
  return web({ driver, browser });
}

/** Launches the engine's browser, as a worker's first test does. */
async function boot(engine: EngineHandle): Promise<void> {
  await engine.init!({
    app: { site: `http://127.0.0.1:${TESTBED_PORT}` },
    projectRoot: ROOT,
    headed: false,
    signal: AbortSignal.timeout(120_000),
  } as never);
}

/** Every artifact directory an attempt made, removed when the bench ends however it ends. */
const tempDirs: string[] = [];

/** Starts an attempt with an artifact directory of its own. */
async function attempt(engine: EngineHandle): Promise<void> {
  const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-bench-'));
  tempDirs.push(artifactsDir);
  await engine.startAttempt!({
    attemptId: 'bench',
    artifactsDir,
    resolveSecret: async () => '',
    signal: AbortSignal.timeout(120_000),
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });
}

/** A cleanup budget for ending an attempt or disposing an engine. */
const cleanup = () => ({ signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 });

/** Boots `engine` with an attempt running; an engine whose boot or attempt failed is disposed before the failure goes on. */
async function driven(engine: EngineHandle): Promise<Driven> {
  try {
    await boot(engine);
    await attempt(engine);
  } catch (cause) {
    await engine.dispose!(cleanup()).catch(() => undefined);
    throw cause;
  }
  return {
    engine,
    open: (url) => engine.session!.open!(url, operation()),
    locateOne: async (expression) => {
      const nodes = await engine.locate!(expression, operation());
      if (nodes.length !== 1) throw new Error(`expected one match, got ${nodes.length}`);
      return nodes[0]!.ref;
    },
    close: async () => {
      try {
        await engine.endAttempt!(cleanup());
      } finally {
        await engine.dispose!(cleanup());
      }
    },
  };
}

/** How many milliseconds `fn` took. */
async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** Every node of an observation tree, depth first. */
function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** The ref of the first node of an observation `predicate` accepts; throws when none does. */
function find(root: SemanticNode, predicate: (node: SemanticNode) => boolean): NodeRef {
  const node = flatten(root).find(predicate);
  if (node === undefined) throw new Error('node not found in observation');
  return node.ref;
}

/** Resident memory (MB) of this process and every descendant, and each one's CPU seconds so far by pid. */
function processTree(): { rssMb: number; cpu: Map<number, number> } {
  const lines = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' }).trim().split('\n');
  const rows = lines.map((line) => {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
    const parts = (cpu ?? '0').split(':').map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), seconds };
  });
  const tree = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
  }
  const members = rows.filter((row) => tree.has(row.pid));
  return {
    rssMb: members.reduce((total, row) => total + row.rss, 0) / 1024,
    cpu: new Map(members.map((row) => [row.pid, row.seconds])),
  };
}

/**
 * Peak memory and CPU of the process tree across samples. A renderer that
 * exits between samples keeps the CPU it showed last, so the total is a
 * floor: work done after a process's last sample is missed.
 */
class ResourceMeter {
  private peakRss = 0;
  private readonly baseline: Map<number, number>;
  private readonly seen = new Map<number, number>();

  constructor() {
    this.baseline = processTree().cpu;
  }

  /** Records the tree's memory now, and each process's CPU so far. */
  sample(): void {
    const { rssMb, cpu } = processTree();
    this.peakRss = Math.max(this.peakRss, rssMb);
    for (const [pid, seconds] of cpu) this.seen.set(pid, Math.max(this.seen.get(pid) ?? 0, seconds));
  }

  /** The peak memory, and the CPU every process used since the meter started. */
  result(): { peakRssMb: number; cpuSeconds: number } {
    let total = 0;
    for (const [pid, seconds] of this.seen) total += seconds - (this.baseline.get(pid) ?? 0);
    return { peakRssMb: this.peakRss, cpuSeconds: total };
  }
}

type Samples = Record<string, number[]>;

/** Adds one timing of `name`. */
function record(samples: Samples, name: string, ms: number): void {
  (samples[name] ??= []).push(ms);
}

/** A testbed page's URL. */
const testbed = (page: string) => `http://127.0.0.1:${TESTBED_PORT}${page}`;
const HEAVY = `http://127.0.0.1:${HEAVY_PORT}/`;

/** The agent-style flow on the todos page: open it, then observe, pick a node from the tree, and act, seven times, and observe the result. */
async function agentFlow(d: Driven): Promise<void> {
  const { engine } = d;
  await d.open(testbed('/todos'));
  for (const title of ['Write spec', 'Ship runner', 'Review PR']) {
    const before = await engine.observe!(operation());
    const field = find(before.root, (node) => node.name === 'New todo');
    await engine.perform!(field, { kind: 'fill', value: title, sensitive: false }, operation());
    const after = await engine.observe!(operation());
    await engine.perform!(find(after.root, (node) => node.role === 'button' && node.name === 'Add'), { kind: 'tap' }, operation());
  }
  const listed = await engine.observe!(operation(), { pixels: true });
  await engine.perform!(find(listed.root, (node) => node.role === 'checkbox' && node.name === 'Ship runner'), { kind: 'tap' }, operation());
  const done = await engine.observe!(operation());
  if (!flatten(done.root).some((node) => node.text?.includes('2 remaining') === true || node.name?.includes('2 remaining') === true)) {
    throw new Error('agent flow did not reach its goal');
  }
}

/** What one driver measured: its samples, its resources over every block, and the node counts of the pages both drivers observe. */
interface DriverRun {
  readonly samples: Samples;
  peakRssMb: number;
  nodeCpuSeconds: number;
  treeCpuSeconds: number;
  readonly work: Record<string, number[]>;
}

/** An empty measurement of one driver. */
function driverRun(): DriverRun {
  return { samples: {}, peakRssMb: 0, nodeCpuSeconds: 0, treeCpuSeconds: 0, work: {} };
}

/** Runs `iterations` warm iterations of every scenario on a fresh engine, into `run`. */
async function warmBlock(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox', iterations: number, run: DriverRun): Promise<void> {
  const { samples, work } = run;
  const d = await driven(engineFor(driver, browser));
  const { engine } = d;
  const meter = new ResourceMeter();
  const sample = () => meter.sample();
  const nodeCpu = process.cpuUsage();
  const nodes = (observed: { root: SemanticNode }) => flatten(observed.root).length;
  try {
    for (let index = 0; index < iterations; index += 1) {
      record(samples, 'new context + page (startAttempt → first open)', await time(async () => {
        await engine.endAttempt!(cleanup());
        await attempt(engine);
        await d.open(testbed('/'));
      }));
      record(samples, 'navigate: testbed /forms', await time(() => d.open(testbed('/forms'))));
      let observed: { root: SemanticNode } | undefined;
      record(samples, 'observe: testbed /forms', await time(async () => {
        observed = await engine.observe!(operation());
      }));
      (work['/forms nodes'] ??= []).push(nodes(observed!));
      record(samples, 'locate role+name: testbed /forms', await time(() => d.locateOne(role('button', 'Save profile'))));
      record(samples, 'click/type sequence: forms (5 actions)', await time(async () => {
        await engine.perform!(await d.locateOne(label('Full name')), { kind: 'fill', value: 'Ada Lovelace', sensitive: false }, operation());
        await engine.perform!(await d.locateOne(label('City')), { kind: 'tap' }, operation());
        await engine.keyboard!.type('Warsaw', { replace: false }, operation());
        await engine.perform!(await d.locateOne(label('Email notifications')), { kind: 'check' }, operation());
        await engine.perform!(await d.locateOne(role('button', 'Save profile')), { kind: 'tap' }, operation());
      }));
      record(samples, 'screenshot: testbed /forms', await time(() => engine.artifacts!.screenshot(undefined, operation())));
      record(samples, 'navigate: testbed /scroll (8k px)', await time(() => d.open(testbed('/scroll'))));
      record(samples, 'navigate: heavy page (9k elements)', await time(() => d.open(HEAVY)));
      record(samples, 'observe: heavy page', await time(async () => {
        observed = await engine.observe!(operation());
      }));
      (work['heavy page nodes'] ??= []).push(nodes(observed!));
      let withPixels: { pixels?: unknown } | undefined;
      record(samples, 'observe + pixels: heavy page', await time(async () => {
        withPixels = await engine.observe!(operation(), { pixels: true });
      }));
      if (withPixels?.pixels === undefined) throw new Error(`${driver}/${browser} observed the heavy page without its pixels`);
      record(samples, 'locate role+name: heavy page', await time(() => d.locateOne(role('button', 'Open 1499'))));
      record(samples, 'locate + fill + tap: heavy page', await time(async () => {
        await engine.perform!(await d.locateOne({ kind: 'query', query: { kind: 'placeholder', value: string('Search customers', true) } }), { kind: 'fill', value: 'acme', sensitive: false }, operation());
        await engine.perform!(await d.locateOne(role('button', 'Search')), { kind: 'tap' }, operation());
      }));
      record(samples, 'screenshot: heavy page', await time(() => engine.artifacts!.screenshot(undefined, operation())));
      sample();
      // The first look at a small page after a 3k-node observation: Playwright releases the old generation's element handles here.
      await d.open(testbed('/forms'));
      record(samples, 'observe: /forms right after a heavy observation', await time(() => engine.observe!(operation())));
      sample();
      await engine.endAttempt!(cleanup());
      await attempt(engine);
      record(samples, 'agent flow: todos (open, 7 actions, 8 observations)', await time(() => agentFlow(d)));
      sample();
    }
    sample();
  } finally {
    await d.close();
  }
  const cpu = process.cpuUsage(nodeCpu);
  const { peakRssMb, cpuSeconds } = meter.result();
  run.peakRssMb = Math.max(run.peakRssMb, peakRssMb);
  run.nodeCpuSeconds += (cpu.user + cpu.system) / 1e6;
  run.treeCpuSeconds += cpuSeconds;
}

/** One cold launch and first page on a fresh engine, into `samples`; the engine is disposed however the iteration ends. */
async function coldIteration(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox', samples: Samples): Promise<void> {
  const engine = engineFor(driver, browser);
  try {
    record(samples, 'cold launch (init)', await time(() => boot(engine)));
    record(samples, 'cold first page (startAttempt → open /forms → observe)', await time(async () => {
      await attempt(engine);
      await engine.session!.open!(testbed('/forms'), operation());
      await engine.observe!(operation());
    }));
    await engine.endAttempt!(cleanup());
  } finally {
    await engine.dispose!(cleanup());
  }
}

/** The drivers in the order of round `round`: alternating, so neither always runs first. */
function inTurn(round: number): ('playwright' | 'bidi')[] {
  return round % 2 === 0 ? DRIVERS : DRIVERS.toReversed();
}

/** A deterministic random source, so a run's intervals can be reproduced. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bootstrap 95% interval of the ratio of `bidi`'s median to `pw`'s. */
function ratioInterval(pw: number[], bidi: number[]): [number, number] {
  const random = seeded(1503);
  const resample = (list: number[]) => Array.from(list, () => list[Math.floor(random() * list.length)]!);
  const ratios = Array.from({ length: 2000 }, () => stats(resample(bidi)).p50 / stats(resample(pw)).p50).toSorted((a, b) => a - b);
  return [ratios[Math.floor(0.025 * ratios.length)]!, ratios[Math.floor(0.975 * ratios.length) - 1]!];
}

/** The median, 95th percentile, mean, and count of `list`. */
function stats(list: number[]): { p50: number; p95: number; mean: number; n: number } {
  const sorted = list.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), mean: list.reduce((a, b) => a + b, 0) / list.length, n: list.length };
}

const app = spawn(process.execPath, ['app/server.mjs'], {
  cwd: path.join(ROOT, 'apps/testbed'),
  env: { ...process.env, PORT: String(TESTBED_PORT) },
  stdio: 'ignore',
});
const heavy = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(heavyPage());
});
await listen(heavy, HEAVY_PORT);
const results: Record<string, { samples: Record<string, ReturnType<typeof stats>>; raw: Samples; resources: Record<string, number>; work: Record<string, number[]> }> = {};
try {
  await waitForHttp(testbed('/'));
  for (const browser of BROWSERS) {
    const runs = new Map(DRIVERS.map((driver) => [driver, driverRun()]));
    for (let index = 0; index < COLD_ITERATIONS; index += 1) {
      for (const driver of inTurn(index)) {
        process.stderr.write(`${driver}/${browser}: cold ${index + 1}\n`);
        await coldIteration(driver, browser, runs.get(driver)!.samples);
      }
    }
    for (let done = 0, round = 0; done < ITERATIONS; done += BLOCK, round += 1) {
      for (const driver of inTurn(round)) {
        process.stderr.write(`${driver}/${browser}: warm ${done + 1}-${Math.min(ITERATIONS, done + BLOCK)}\n`);
        await warmBlock(driver, browser, Math.min(BLOCK, ITERATIONS - done), runs.get(driver)!);
      }
    }
    for (const [driver, run] of runs) {
      results[`${driver}/${browser}`] = {
        samples: Object.fromEntries(Object.entries(run.samples).map(([name, list]) => [name, stats(list)])),
        raw: run.samples,
        resources: {
          'peak RSS, node + browser (MB)': run.peakRssMb,
          'node CPU, warm loop (s)': run.nodeCpuSeconds,
          'node + browser CPU, warm loop (s, floor)': run.treeCpuSeconds,
        },
        work: run.work,
      };
    }
  }
} finally {
  app.kill();
  heavy.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Wall-clock milliseconds of one whole testbed run on `driver` and `browser`, at the testbed's own concurrency. */
function testbedRun(driver: 'playwright' | 'bidi', browser: 'chromium' | 'firefox'): Promise<{ ms: number; passed: boolean }> {
  const cwd = path.join(ROOT, 'apps/testbed');
  const args = [path.join(cwd, 'node_modules/e2e/dist/cli/bin.js'), 'run', '--config', browser === 'firefox' ? 'e2e.firefox.config.ts' : 'e2e.config.ts'];
  if (browser === 'firefox') args.push('--grep-invert', FIREFOX_SKIPS);
  const start = performance.now();
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, E2E_WEB_DRIVER: driver }, stdio: 'ignore' });
  return new Promise((resolve) => child.once('exit', (code) => resolve({ ms: performance.now() - start, passed: code === 0 })));
}

const testbedTimes: Record<string, { median: number; runs: number[]; passed: boolean }> = {};
for (const browser of BROWSERS) {
  for (let index = 0; index < TESTBED_RUNS; index += 1) {
    for (const driver of inTurn(index)) {
      process.stderr.write(`${driver}/${browser}: testbed run ${index + 1}\n`);
      const run = await testbedRun(driver, browser);
      const times = (testbedTimes[`${driver}/${browser}`] ??= { median: 0, runs: [], passed: true });
      times.runs.push(run.ms);
      times.passed &&= run.passed;
      times.median = stats(times.runs).p50;
    }
  }
}

/** One driver's totals over every scenario, the realistic test, and the whole testbed. */
function totals(key: string): Record<string, number> {
  const samples = results[key]!.samples;
  const p50 = (name: string): number => samples[name]?.p50 ?? 0;
  const agentStep = (p50('agent flow: todos (open, 7 actions, 8 observations)') - p50('navigate: testbed /forms')) / AGENT_FLOW_ACTIONS;
  return {
    'sum of p50s, every scenario (ms)': Object.values(samples).reduce((total, s) => total + s.p50, 0),
    'sum of means, every scenario (ms)': Object.values(samples).reduce((total, s) => total + s.mean, 0),
    [`realistic test: cold launch + new page + ${STEPS_PER_TEST} agent steps (ms)`]: p50('cold launch (init)') + p50('new context + page (startAttempt → first open)') + STEPS_PER_TEST * agentStep,
    [`testbed wall clock, median of ${TESTBED_RUNS} (ms)`]: testbedTimes[key]?.median ?? 0,
    'node CPU, warm loop (s)': results[key]!.resources?.['node CPU, warm loop (s)'] ?? 0,
    'node + browser CPU, warm loop (s, floor)': results[key]!.resources?.['node + browser CPU, warm loop (s, floor)'] ?? 0,
    'peak RSS, node + browser (MB)': results[key]!.resources?.['peak RSS, node + browser (MB)'] ?? 0,
  };
}

const meta = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}`,
  node: process.version,
  iterations: ITERATIONS,
  coldIterations: COLD_ITERATIONS,
  testbedRuns: TESTBED_RUNS,
  stepsPerTest: STEPS_PER_TEST,
};
for (const browser of BROWSERS) {
  const pages = new Set(DRIVERS.flatMap((driver) => Object.keys(results[`${driver}/${browser}`]!.work)));
  for (const page of pages) {
    const counts = new Set(DRIVERS.flatMap((driver) => results[`${driver}/${browser}`]!.work[page] ?? []));
    if (counts.size !== 1) throw new Error(`${browser}: the drivers observed ${page} differently (${[...counts].join(', ')} nodes); the timings are not of equal work`);
  }
}
const summary = Object.fromEntries(Object.keys(results).map((key) => [key, totals(key)]));
writeFileSync(values.out, JSON.stringify({ meta, results, testbed: testbedTimes, totals: summary }, null, 2));


const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));
for (const browser of BROWSERS) {
  const keys = DRIVERS.map((driver) => `${driver}/${browser}`);
  const names = Object.keys(results[keys[0]!]!.samples);
  console.log(`\n### ${browser}\n`);
  console.log(`| Scenario (ms) | ${keys.map((key) => `${key.split('/')[0]} p50 / p95 / mean`).join(' | ')} | BiDi vs PW (p50, 95% CI) |`);
  console.log(`| --- | ${keys.map(() => '---').join(' | ')} | --- |`);
  for (const name of names) {
    const cells = keys.map((key) => {
      const s = results[key]!.samples[name]!;
      return `${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.mean)}`;
    });
    const pw = results[`playwright/${browser}`]?.raw[name];
    const bidi = results[`bidi/${browser}`]?.raw[name];
    const interval = pw !== undefined && bidi !== undefined ? ratioInterval(pw, bidi) : undefined;
    const ratio = pw !== undefined && bidi !== undefined && interval !== undefined
      ? `${(stats(bidi).p50 / stats(pw).p50).toFixed(2)}x (${interval[0].toFixed(2)}-${interval[1].toFixed(2)})`
      : '';
    console.log(`| ${name} | ${cells.join(' | ')} | ${ratio} |`);
  }
  for (const resource of Object.keys(results[keys[0]!]!.resources ?? {})) {
    console.log(`| ${resource} | ${keys.map((key) => fmt(results[key]!.resources![resource]!)).join(' | ')} | |`);
  }
}
console.log('\n### Totals\n');
console.log(`| Total | ${BROWSERS.flatMap((browser) => DRIVERS.map((driver) => `${driver} ${browser}`)).join(' | ')} | ${BROWSERS.map((browser) => `BiDi vs PW ${browser}`).join(' | ')} |`);
console.log(`| --- | ${BROWSERS.flatMap(() => DRIVERS.map(() => '---')).join(' | ')} | ${BROWSERS.map(() => '---').join(' | ')} |`);
for (const name of Object.keys(summary[Object.keys(summary)[0]!]!)) {
  const cells = BROWSERS.flatMap((browser) => DRIVERS.map((driver) => fmt(summary[`${driver}/${browser}`]![name]!)));
  const changes = BROWSERS.map((browser) => {
    const pw = summary[`playwright/${browser}`]?.[name];
    const bidi = summary[`bidi/${browser}`]?.[name];
    if (pw === undefined || bidi === undefined || pw === 0) return '';
    const change = ((bidi - pw) / pw) * 100;
    return `${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
  });
  console.log(`| ${name} | ${cells.join(' | ')} | ${changes.join(' | ')} |`);
}
for (const [key, run] of Object.entries(testbedTimes)) if (!run.passed) console.log(`\nnote: a ${key} testbed run failed; its wall clock includes the failure`);
console.log(`\n${JSON.stringify(meta)}`);
