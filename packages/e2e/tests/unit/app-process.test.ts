/** AppProcess startup: the readiness wait honours the run's interrupt. */

import { describe, expect, it } from 'vitest';
import { AppProcess } from '../../src/run/app-process.ts';

describe('AppProcess', () => {
  it('stops waiting for readiness and takes the process down when the signal aborts', async () => {
    // A child that never serves anything, and a ready URL that never answers.
    const app = new AppProcess(
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        startupTimeout: 30_000,
        shutdownTimeout: 2_000,
      },
      process.cwd(),
      'http://127.0.0.1:1/',
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const startedAt = Date.now();
    await app.start(controller.signal);
    // Well inside the startup timeout: the abort, not the deadline, ended the wait.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The child is already gone; a second stop is a no-op rather than a hang.
    await app.stop();
  }, 20_000);
});
