/**
 * The child-process runner against a real forked worker whose IPC channel is
 * severed before the worker code runs: the state a runner reaches between a
 * worker's `disconnect` and its `close`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, type EngineCleanupContext, type EngineHandle } from '../../src/engine/index.ts';
import { SessionStore } from '../../src/run/sessions.ts';
import { TargetWorker } from '../../src/run/worker/session.ts';
import { childProcessSpawner } from '../../src/run/worker/handle.ts';

/** A promise the test releases after observing a lifecycle event. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Runs `init` on the target's protocol client, as a worker's first session
 * would: `dispose` reaches an engine only over a connection `init` opened.
 */
async function initialized(engine: EngineHandle): Promise<void> {
  await engine.init!({
    runId: 'run', targetName: 'fake', projectRoot: PACKAGE_ROOT, app: {}, env: {}, headed: false, workerSlot: 0,
    signal: new AbortController().signal, log: () => {},
  });
}

/** The worker runs from the package like the runner's own do. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Preloaded into the worker ahead of its entry: drops the channel at once and
 * holds the process open for a second, past the exit the entry itself asks
 * for on `disconnect`. The runner then sees a child whose channel is gone but
 * whose process is not.
 */
const SEVER_CHANNEL = `const exit = process.exit.bind(process);
process.exit = () => undefined;
setTimeout(() => exit(0), 1000);
process.disconnect();
`;

/** Longer than the second the preload holds the worker open, shorter than the test budget. */
const WORKER_LIFETIME_MS = 10_000;

describe('ChildProcessRunner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-worker-handle-'));
  const preload = path.join(dir, 'sever-channel.mjs');
  writeFileSync(preload, SEVER_CHANNEL, 'utf8');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops messages to a worker whose channel closed ahead of its process', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (cause: unknown): void => {
      uncaught.push(cause);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const spawn = childProcessSpawner({
        configPath: path.join(dir, 'e2e.config.ts'),
        projectRoot: PACKAGE_ROOT,
        configDigest: 'none',
        cli: {},
        ports: {},
        runId: 'run',
        artifactsRoot: dir,
        rerunDir: undefined,
        headed: false,
        sessionsRoot: dir,
        sessionKeyBase64: '',
        debug: false,
        aiTrace: false,
        envFor: () => ({ ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` }),
      });
      let exit: string | undefined;
      const runner = spawn('web', 0, {
        onMessage: () => undefined,
        onExit: (detail) => {
          exit = detail;
        },
      });
      // Two sends per turn until the process is gone: the pair the scheduler
      // issues in one loop iteration, an interrupt and then a terminate.
      const deadline = Date.now() + WORKER_LIFETIME_MS;
      try {
        while (runner.alive && Date.now() < deadline) {
          runner.send({ type: 'interrupt' });
          runner.send({ type: 'terminate' });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        // A worker that outlived its second would otherwise hold the channel, and this process, open.
        if (runner.alive) runner.kill();
      }
      await runner.exit;
      expect(exit).toBe('code 0, signal null');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});

describe('TargetWorker disposal', () => {
  it.each(['terminate', 'shutdown'] as const)('revokes pending retirement on %s and disposes once', async (escalation) => {
    const ready = deferred<void>();
    const disposing = deferred<void>();
    const finishDisposal = deferred<void>();
    const finished = deferred<void>();
    const events: string[] = [];
    const engine = defineEngine({
      name: 'cleanup', version: '1.0.0', spiVersion: 1,
      async dispose(context: EngineCleanupContext & { readonly reuseSignal?: AbortSignal }) {
        events.push(context.reuseSignal !== undefined && !context.reuseSignal.aborted ? 'dispose-reusable' : 'dispose-final');
        context.reuseSignal?.addEventListener('abort', () => events.push('close'), { once: true });
        disposing.resolve();
        await finishDisposal.promise;
        events.push('disposed');
      },
    });
    const config = resolveConfig({ targets: [{ name: 'fake', platform: 'ios', engine }], cache: 'off' }, { projectRoot: PACKAGE_ROOT, env: {} });
    await initialized(config.targets[0]!.engine!);
    const worker = new TargetWorker({
      emit: (message) => {
        if (message.type === 'ready') ready.resolve();
        else if (message.type === 'shutdown-done') events.push('shutdown-done');
      },
      fatal: (cause) => { throw cause; },
      finished: () => { events.push('finished'); finished.resolve(); },
    }, async () => ({
      config, target: config.targets[0]!, sessionStore: SessionStore.create('run', tmpdir()),
      runId: 'run', artifactsRoot: tmpdir(), rerunDir: undefined, headed: false,
      workerSlot: 0, env: {}, isolated: true, resolvePairs: async () => ({ pairs: [], missing: [] }),
    }));
    worker.start();
    await ready.promise;
    const retirement = { type: 'shutdown', preserveResources: true } as const;
    worker.handle(retirement);
    await disposing.promise;
    try {
      expect(events).toEqual(['dispose-reusable']);
      worker.handle({ type: escalation });
      await vi.waitFor(() => expect(events).toEqual(['dispose-reusable', 'close']));
      worker.handle({ type: 'terminate' });
    } finally {
      finishDisposal.resolve();
      await finished.promise;
    }
    expect(events).toEqual(['dispose-reusable', 'close', 'disposed', 'shutdown-done', 'finished']);
  });

  it.each([
    { messages: [{ type: 'shutdown' }] as const },
    { messages: [{ type: 'shutdown', preserveResources: true }, { type: 'shutdown' }] as const },
  ])('defaults to final cleanup and revokes before queued disposal starts %#', async ({ messages }) => {
    const ready = deferred<void>();
    const finished = deferred<void>();
    const events: string[] = [];
    const engine = defineEngine({
      name: 'cleanup', version: '1.0.0', spiVersion: 1,
      async dispose(context: EngineCleanupContext & { readonly reuseSignal?: AbortSignal }) {
        events.push(context.reuseSignal !== undefined && !context.reuseSignal.aborted ? 'reusable' : 'final');
      },
    });
    const config = resolveConfig({ targets: [{ name: 'fake', platform: 'ios', engine }], cache: 'off' }, { projectRoot: PACKAGE_ROOT, env: {} });
    await initialized(config.targets[0]!.engine!);
    const worker = new TargetWorker({
      emit: (message) => { if (message.type === 'ready') ready.resolve(); },
      fatal: (cause) => { throw cause; }, finished: () => finished.resolve(),
    }, async () => ({
      config, target: config.targets[0]!, sessionStore: SessionStore.create('run', tmpdir()),
      runId: 'run', artifactsRoot: tmpdir(), rerunDir: undefined, headed: false,
      workerSlot: 0, env: {}, isolated: true, resolvePairs: async () => ({ pairs: [], missing: [] }),
    }));
    worker.start();
    await ready.promise;
    for (const message of messages) worker.handle(message);
    await finished.promise;
    expect(events).toEqual(['final']);
  });
});
