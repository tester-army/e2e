import { afterEach, describe, expect, it, vi } from 'vitest';

/** `exitIfStopped` and `leaveWorkBehind` from fresh modules, so work one test leaves behind is not the next one's. */
async function fresh() {
  vi.resetModules();
  const [{ exitIfStopped }, { leaveWorkBehind }] = await Promise.all([import('../../src/cli/run-output.ts'), import('../../src/internal/abandoned.ts')]);
  return { exitIfStopped, leaveWorkBehind };
}

/** Stdout and stderr backed up, as a slow pipe is: each write's callback waits in `pending` until the test releases it. */
function backedUpTerminal(): { stream: 'stdout' | 'stderr'; release: () => void }[] {
  const pending: { stream: 'stdout' | 'stderr'; release: () => void }[] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    vi.spyOn(process[stream], 'write').mockImplementation((...args: unknown[]) => {
      const callback = args.find((arg) => typeof arg === 'function');
      if (callback !== undefined) pending.push({ stream, release: callback as () => void });
      return false;
    });
  }
  return pending;
}

/** Lets every pending callback and timer phase run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('exitIfStopped', () => {
  it('exits once stdout and stderr took what was written when work was left behind, whatever the exit code', async () => {
    for (const code of [0, 3]) {
      const { exitIfStopped, leaveWorkBehind } = await fresh();
      const pending = backedUpTerminal();
      const exit = vi.fn();
      process.exitCode = code;
      leaveWorkBehind();
      const exited = exitIfStopped(exit);
      await settle();
      expect(pending.map(({ stream }) => stream)).toEqual(['stdout', 'stderr']);
      pending[0]?.release();
      await settle();
      expect(exit, `exit code ${code}`).not.toHaveBeenCalled();
      pending[1]?.release();
      await exited;
      expect(exit, `exit code ${code}`).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    }
  });

  it('exits once the output is out after Ctrl-C, with no work left behind', async () => {
    const { exitIfStopped } = await fresh();
    const pending = backedUpTerminal();
    const exit = vi.fn();
    process.exitCode = 130;
    const exited = exitIfStopped(exit);
    await settle();
    for (const { release } of pending) release();
    await exited;
    expect(exit).toHaveBeenCalledOnce();
  });

  it('leaves the process to end on its own when nothing stopped it', async () => {
    const { exitIfStopped } = await fresh();
    const pending = backedUpTerminal();
    const exit = vi.fn();
    for (const code of [undefined, 0, 1, 3]) {
      process.exitCode = code;
      await exitIfStopped(exit);
    }
    expect(exit).not.toHaveBeenCalled();
    expect(pending).toEqual([]);
  });
});
