/**
 * The child-process runner against a real forked worker whose IPC channel is
 * severed before the worker code runs: the state a runner reaches between a
 * worker's `disconnect` and its `close`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { childProcessSpawner } from '../../src/run/worker/handle.ts';

/** The worker runs from the package like the runner's own do: tsx reads its tsconfig from there. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Preloaded into the worker ahead of its entry: drops the channel at once and
 * holds the process open for a second, past the exit the entry itself asks
 * for on `disconnect`. The runner then sees a child whose channel is gone but
 * whose process is not. Main thread only: from Node 24 a preload also runs in
 * the module-hooks thread tsx registers, which has no channel to drop and
 * whose exit the main thread's own exit waits on.
 */
const SEVER_CHANNEL = `import { isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const exit = process.exit.bind(process);
  process.exit = () => undefined;
  setTimeout(() => exit(0), 1000);
  process.disconnect();
}
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
