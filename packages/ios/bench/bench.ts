/**
 * Engine-level latency of the Swift iOS engine against `mobile()` on
 * agent-device: the same calls through the engine contract, on the same
 * simulator (`E2E_IOS_UDID`) and the same screens of the mobile benchmark
 * app (`dev.e2e.benchmark`, installed). Prints a table of medians and
 * writes the samples to `bench/results.json`.
 *
 *   E2E_IOS_UDID=<udid> node bench/bench.ts [--rounds 20]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mobile } from '@e2e-dev/mobile';
import type { EngineHandle, OperationContext, SemanticNode } from 'e2e/engine';
import { ios } from '../src/index.ts';

const APP = 'dev.e2e.benchmark';
/** `--rounds <n>`, a positive integer; 20 when the flag is absent. */
function roundsFlag(): number {
  const at = process.argv.indexOf('--rounds');
  if (at === -1) return 20;
  const value = Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error('--rounds takes a positive integer');
  return value;
}

const rounds = roundsFlag();

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 30_000, runId: 'bench', attemptId: 'bench-1', origin: 'test' });

/** Every node of a tree, depth first. */
function nodes(root: SemanticNode): SemanticNode[] {
  return [root, ...(root.children ?? []).flatMap(nodes)];
}

async function find(engine: EngineHandle, predicate: (node: SemanticNode) => boolean, timeoutMs = 10_000): Promise<SemanticNode> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = nodes((await engine.observe!(operation())).root).find(predicate);
    if (match !== undefined) return match;
    if (Date.now() > deadline) throw new Error('node not found in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const byTestId = (id: string) => (node: SemanticNode): boolean => node.testId === id || node.testId?.endsWith(`:id/${id}`) === true;
const byLabel = (label: string) => (node: SemanticNode): boolean => node.name?.startsWith(label) === true;

/** Times `fn` once, in milliseconds. */
async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

type Samples = Record<string, number[]>;

/** Calls that failed, by engine and operation. */
const failed: Record<string, Record<string, string[]>> = {};

async function measure(label: string, engine: EngineHandle): Promise<Samples> {
  const samples: Samples = {};
  const failures: Record<string, string[]> = {};
  failed[label] = failures;
  // A call that fails counts as a failure of that row, not of the run: the
  // engines refuse different things (agent-device refuses a swipe that moves
  // nothing), and the rest is still worth measuring.
  const record = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    samples[name] ??= [];
    try {
      samples[name].push(await time(fn));
    } catch (cause) {
      (failures[name] ??= []).push(String(cause instanceof Error ? cause.message : cause).split('\n')[0]!);
    }
  };
  const env: Record<string, string | undefined> = { ...process.env };
  const signal = new AbortController().signal;
  const log = (line: string): void => {
    process.stderr.write(`[${label}] ${line}\n`);
  };
  let prepared = false;
  let initialized = false;
  let attempted = false;
  try {
    // Cold start is timed but not tolerated: nothing after it can run on an
    // engine that did not start.
    samples['prepare + init (cold)'] = [];
    samples['prepare + init (cold)'].push(await time(async () => {
      // `finish` releases a `prepare` that threw part-way too.
      prepared = engine.prepare !== undefined;
      const result = await engine.prepare?.({ runId: 'bench', targetName: 'ios', projectRoot: process.cwd(), app: { bundleId: APP }, slots: 1, env, headed: false, signal, log });
      Object.assign(env, result?.env ?? {});
      initialized = true;
      await engine.init!({ runId: 'bench', targetName: 'ios', projectRoot: process.cwd(), app: { bundleId: APP }, env, headed: false, workerSlot: 0, signal, log });
    }));
    attempted = true;
    await engine.startAttempt!({
      attemptId: 'bench-1',
      artifactsDir: `/tmp/e2e-ios-bench/${label}`,
      signal,
      resolveSecret: async () => '',
      appLog: () => {},
      navigation: () => {},
      environment: () => {},
    });
    for (let round = 0; round < 3; round += 1) await record('restart app', () => engine.session!.restart!(operation()));
    await find(engine, byLabel('Login Form. '));
    for (let round = 0; round < rounds; round += 1) await record('observe (home list)', () => engine.observe!(operation()));
    for (let round = 0; round < Math.min(rounds, 5); round += 1) {
      await record('swipe (viewport)', () => engine.perform!({ id: 'root', revision: '' }, { kind: 'swipe', direction: round % 2 === 0 ? 'down' : 'up' }, operation()));
    }
    await engine.session!.restart!(operation());
    for (let round = 0; round < Math.min(rounds, 5); round += 1) {
      const row = await find(engine, byLabel('Login Form. '));
      await record('tap row -> next screen visible', async () => {
        await engine.perform!(row.ref, { kind: 'tap' }, operation());
        await find(engine, byTestId('email-input'));
      });
      await record('back -> list visible', async () => {
        await engine.session!.back!(operation());
        await find(engine, byLabel('Login Form. '));
      });
    }
    // A back that failed above leaves the app elsewhere, and a tap on the
    // list can open a neighbour on iOS (the benchmark's `openScenario`
    // retries for the same reason): every engine reaches the form the same
    // way, from a fresh list, a few tries at most.
    for (let attempt = 1; ; attempt += 1) {
      await engine.session!.restart!(operation());
      const row = await find(engine, byLabel('Login Form. '));
      await engine.perform!(row.ref, { kind: 'tap' }, operation());
      const opened = await find(engine, byTestId('email-input'), 5_000).then(() => true, () => false);
      if (opened) break;
      if (attempt === 3) throw new Error('the Login Form never opened');
    }
    for (let round = 0; round < rounds; round += 1) await record('observe (form)', () => engine.observe!(operation()));
    if (engine.locate !== undefined) {
      const expression = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'email-input', exact: true } } } as const;
      for (let round = 0; round < rounds; round += 1) await record('locate getByTestId', () => engine.locate!(expression, operation()));
    }
    for (let round = 0; round < rounds; round += 1) {
      const field = await find(engine, byTestId('email-input'));
      await record('tap', () => engine.perform!(field.ref, { kind: 'tap' }, operation()));
    }
    for (let round = 0; round < rounds; round += 1) {
      const field = await find(engine, byTestId('email-input'));
      await record('fill (19 chars)', () => engine.perform!(field.ref, { kind: 'fill', value: `user${String(round).padStart(2, '0')}@example.test`, sensitive: false }, operation()));
    }
    for (let round = 0; round < Math.min(rounds, 10); round += 1) {
      await record('keyboard.type (10 chars)', () => engine.keyboard!.type('abcdefghij', { replace: false }, operation()));
    }
    for (let round = 0; round < Math.min(rounds, 10); round += 1) {
      const field = await find(engine, byTestId('email-input'));
      await record('press Enter on node', () => engine.perform!(field.ref, { kind: 'press', key: 'Enter' }, operation()));
    }
    for (let round = 0; round < Math.min(rounds, 5); round += 1) await record('screenshot', () => engine.artifacts!.screenshot(`bench-${String(round)}`, operation()));
    for (let round = 0; round < Math.min(rounds, 5); round += 1) await record('observe with pixels', () => engine.observe!(operation(), { pixels: true }));
  } finally {
    // Each phase is released even when one before it failed, so a broken run
    // leaves no device session behind.
    const phases: [boolean, () => Promise<void> | undefined][] = [
      [attempted, () => engine.endAttempt?.({ signal, timeoutMs: 10_000 })],
      [initialized, () => engine.dispose?.({ signal, timeoutMs: 10_000 })],
      [prepared, () => engine.finish?.({ runId: 'bench', targetName: 'ios', env, log, signal, timeoutMs: 10_000 })],
    ];
    for (const [started, release] of phases) {
      if (started) {
        await Promise.resolve(release()).catch((cause: unknown) => {
          log(`cleanup failed: ${String(cause)}`);
          process.exitCode = 1;
        });
      }
    }
  }
  return samples;
}

/** The nearest-rank percentile: the smallest sample at or above `fraction` of them. */
const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
};

const results: Record<string, Samples> = {};
const udid = process.env['E2E_IOS_UDID'];
if (udid === undefined) throw new Error('set E2E_IOS_UDID to the simulator to measure on');
const factories: Record<string, () => EngineHandle> = {
  'agent-device': () => mobile({ platform: 'ios', device: udid, session: 'e2e-ios-bench', transition: 1_500 }),
  direct: () => ios({ udid }),
  'direct, no idle wait': () => ios({ udid, waitForIdle: false }),
};
// One engine that fails to run still leaves the others' samples.
for (const [label, engine] of Object.entries(factories)) {
  try {
    results[label] = await measure(label, engine());
  } catch (cause) {
    process.stderr.write(`[${label}] failed: ${String(cause)}\n`);
    process.exitCode = 1;
  }
}
writeFileSync(path.join(import.meta.dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

const engines = Object.keys(results);
const operations = [...new Set(Object.values(results).flatMap((samples) => Object.keys(samples)))];
const format = (value: number): string => (Number.isNaN(value) ? '-' : value >= 100 ? value.toFixed(0) : value.toFixed(1));
const cell = (engine: string, name: string): string => {
  const values = results[engine]?.[name] ?? [];
  const failures = failed[engine]?.[name]?.length ?? 0;
  return `${format(percentile(values, 0.5))}${failures > 0 ? ` (${failures} failed)` : ''}`;
};
const rows = operations.map((name) => `| ${name} | ${engines.map((engine) => cell(engine, name)).join(' | ')} |`);
process.stdout.write(
  [`| operation (p50 ms) | ${engines.join(' | ')} |`, `|---|${engines.map(() => '---|').join('')}`, ...rows].join('\n') + '\n',
);
for (const [engine, byOperation] of Object.entries(failed)) {
  for (const [name, messages] of Object.entries(byOperation)) process.stdout.write(`${engine} / ${name}: ${messages[0]}\n`);
}
