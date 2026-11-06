/** One engine attempt outside any run, for code that drives an app before tests do. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../config/resolve.ts';
import type { EngineHandle } from '../engine/index.ts';
import type { SerializedError } from '../internal/errors.ts';
import type { TestFixtures } from '../types.ts';
import { openStandaloneAttempt } from './standalone.ts';

export interface OpenEngineOptions {
  /** Directory relative paths resolve against; default `process.cwd()`. */
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Cancels opening and every operation. `close` still releases what was opened. */
  readonly signal?: AbortSignal | undefined;
  /** Deadline for the session's operations in milliseconds, counted from when it opens; default 120000. */
  readonly timeout?: number | undefined;
  readonly headed?: boolean | undefined;
}

export interface EngineSession<Fixtures extends object = Record<string, unknown>> extends AsyncDisposable {
  /** `screen`, `app`, and the fixtures the engine contributes, as a test gets them. */
  readonly fixtures: TestFixtures & Fixtures;
  /** Ends the attempt and disposes the engine. Idempotent. Throws an `AggregateError` of what failed. */
  close(): Promise<void>;
}

/**
 * Opens one attempt on `engine` with no config, test, or agent, and hands
 * back its fixtures: the same `screen` and engine fixtures a test gets, typed
 * as the engine declares them, with the same waiting and errors. Nothing is
 * written to the project.
 */
export async function openEngine<Fixtures extends object = Record<string, unknown>>(
  engine: EngineHandle<Fixtures>,
  options: OpenEngineOptions = {},
): Promise<EngineSession<Fixtures>> {
  const env = options.env ?? process.env;
  const output = mkdtempSync(path.join(tmpdir(), 'e2e-engine-'));
  const removeOutput = (): void => rmSync(output, { recursive: true, force: true });
  try {
    const resolved = resolveConfig(
      { targets: [{ engine }], video: 'off', ...(options.timeout === undefined ? {} : { timeout: options.timeout }) },
      { projectRoot: options.cwd ?? process.cwd(), env },
    );
    // Artifacts go to a directory of the session's own, never a run's results.
    const config = { ...resolved, output };
    const target = config.targets[0]!;
    const attempt = await openStandaloneAttempt({
      config, target, env, headed: options.headed ?? false,
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: config.timeout,
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        let failures: readonly SerializedError[];
        try {
          failures = await attempt.close();
        } finally {
          removeOutput();
        }
        if (failures.length > 0) throw new AggregateError(failures, `closing the ${engine.name} engine failed: ${failures.map((failure) => failure.message).join('; ')}`);
      })();
      return closing;
    };
    return { fixtures: attempt.fixtures as TestFixtures & Fixtures, close, [Symbol.asyncDispose]: close };
  } catch (cause) {
    removeOutput();
    throw cause;
  }
}
