/**
 * Engine-level latency of the direct Android engine against `mobile()` on
 * agent-device: the same calls through the engine contract, on the same
 * emulator and the same screens of the mobile benchmark app
 * (`dev.e2e.benchmark`, installed). Prints a table of medians and p95s and
 * writes the samples to `bench/results.json`.
 *
 *   node bench/bench.ts [--rounds 20]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mobile } from '@e2e-dev/mobile';
import type { EngineHandle, OperationContext, SemanticNode } from 'e2e/engine';
import { android } from '../src/index.ts';

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

async function measure(label: string, engine: EngineHandle): Promise<Samples> {
  const samples: Samples = {};
  const record = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    (samples[name] ??= []).push(await time(fn));
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
    await record('prepare + init (cold)', async () => {
      // `finish` releases a `prepare` that threw part-way too.
      prepared = engine.prepare !== undefined;
      const result = await engine.prepare?.({ runId: 'bench', targetName: 'android', projectRoot: process.cwd(), app: { bundleId: APP }, slots: 1, env, headed: false, signal, log });
      Object.assign(env, result?.env ?? {});
      initialized = true;
      await engine.init!({ runId: 'bench', targetName: 'android', projectRoot: process.cwd(), app: { bundleId: APP }, env, headed: false, workerSlot: 0, signal, log });
    });
    attempted = true;
    await engine.startAttempt!({
      attemptId: 'bench-1',
      artifactsDir: `/tmp/e2e-android-bench/${label}`,
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
    const row = await find(engine, byLabel('Login Form. '));
    await engine.perform!(row.ref, { kind: 'tap' }, operation());
    await find(engine, byTestId('email-input'));
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
      [prepared, () => engine.finish?.({ runId: 'bench', targetName: 'android', env, log, signal, timeoutMs: 10_000 })],
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
results['agent-device'] = await measure('agent-device', mobile({ platform: 'android', session: 'e2e-android-bench' }));
results['direct'] = await measure('direct', android());
writeFileSync(path.join(import.meta.dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

const operations = Object.keys(results['agent-device'] ?? {});
const format = (value: number): string => (Number.isNaN(value) ? '-' : value >= 100 ? value.toFixed(0) : value.toFixed(1));
const rows = operations.map((name) => {
  const slow = results['agent-device']?.[name] ?? [];
  const fast = results['direct']?.[name] ?? [];
  const speedup = percentile(slow, 0.5) / percentile(fast, 0.5);
  return `| ${name} | ${slow.length} | ${format(percentile(slow, 0.5))} | ${format(percentile(slow, 0.95))} | ${format(percentile(fast, 0.5))} | ${format(percentile(fast, 0.95))} | ${Number.isFinite(speedup) ? `${speedup.toFixed(1)}x` : '-'} |`;
});
process.stdout.write(
  ['| operation (ms) | samples | agent-device p50 | p95 | direct p50 | p95 | speedup |', '|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n',
);
