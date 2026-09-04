/**
 * The backend against a real tmux server on a private socket, driving `cat`:
 * what is typed echoes back, a chord ends the program, and the dead pane
 * keeps its last screen. Opt in with `E2E_TMUX_INTEGRATION=1`; without tmux
 * on the machine the suite is skipped loudly rather than passing.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@e2edev/e2e/backend';
import { tmux } from '../../src/backend.ts';
import { surfaceOf } from '../../src/backend.ts';

const enabled = process.env['E2E_TMUX_INTEGRATION'] === '1';

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 10_000, runId: 'it', attemptId: 'a1' };
}

describe.skipIf(!enabled)('tmux backend on a real server', () => {
  it('runs a program, observes what it prints, types into it, and sees it exit', async () => {
    if (!hasTmux()) throw new Error('E2E_TMUX_INTEGRATION=1 but tmux is not installed');
    const backend = tmux({ command: 'cat', columns: 40, rows: 8, session: `e2e-it-${process.pid}` });
    const surface = surfaceOf(backend)!;
    const log: string[] = [];
    await backend.prepare!({ runId: `it-${process.pid}`, targetName: 'cat', env: process.env, signal: new AbortController().signal, log: (line) => log.push(line) });
    expect(log[0]).toMatch(/^tmux \d/);
    await backend.init!({
      runId: `it-${process.pid}`,
      targetName: 'cat',
      projectRoot: process.cwd(),
      app: { allowedOrigins: [] },
      testIdAttribute: 'data-testid',
      headed: false,
      signal: new AbortController().signal,
    });
    try {
      await backend.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp/none', signal: AbortSignal.timeout(10_000) });
      const first = await backend.observe!(operation());
      expect(first.viewport).toEqual({ width: 40, height: 8, scale: 1 });
      const prompt = first.nodes[0]!.children!.find((node) => node.role === 'textbox')!;
      expect(prompt.states?.focused).toBe(true);

      await backend.perform!(prompt.ref, { kind: 'fill', value: 'hello from e2e', sensitive: false }, operation());
      await backend.perform!(prompt.ref, { kind: 'press', key: 'Enter' }, operation());
      const echoed = await surface.waitForText(/^hello from e2e$/, 5_000, new AbortController().signal);
      expect(echoed).toBe('hello from e2e');
      // cat echoes each line once itself; the terminal shows the typed line too.
      expect((await surface.text()).split('\n').filter((line) => line === 'hello from e2e')).toHaveLength(2);
      expect(await backend.url!(operation())).toMatch(/^app:\/\/terminal\/cat\//);

      const stale = await backend.perform!(prompt.ref, { kind: 'press', key: 'Control+D' }, operation()).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(stale).toBeUndefined();
      expect(await surface.waitForExit(5_000, new AbortController().signal)).toBe(0);
      const last = await backend.observe!(operation());
      expect(last.nodes[0]!.states).toEqual({ disabled: true });
      expect(last.nodes[0]!.children!.at(-1)!.text).toBe('the program exited with status 0');
    } finally {
      await backend.endAttempt!({ signal: new AbortController().signal, timeoutMs: 5_000 });
      await backend.dispose!({ signal: new AbortController().signal, timeoutMs: 5_000 });
    }
  });
});
