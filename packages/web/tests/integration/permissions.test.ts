/**
 * A web target's `app.permissions` in a real browser: headless Chromium
 * refuses the clipboard to a page unless the target grants it, and a grant
 * holds on every context the attempt opens. Driven through the engine hooks,
 * as the attempt executor drives them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppPermissionState, EngineCleanupContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-permissions', attemptId: 'p1', origin: 'test' };
}

describe('app permissions', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-permissions-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Boots one engine into a running attempt for a target granting `permissions`. */
  async function boot(permissions?: Readonly<Record<string, AppPermissionState>>): Promise<EngineHandle> {
    const engine = web();
    await engine.init!({
      runId: 'run-permissions', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname, ...(permissions === undefined ? {} : { permissions }) }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'p1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return engine;
  }

  async function shutdown(engine: EngineHandle): Promise<void> {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }

  /** Opens the app and copies `text` through the async clipboard, reading it back: the text, or the error the page got. */
  async function copy(engine: EngineHandle, text: string): Promise<string> {
    await engine.session!.open!(app.url, operation());
    return surfaceOf(engine)!.page().evaluate(async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return await navigator.clipboard.readText();
      } catch (error) {
        return String(error);
      }
    }, text);
  }

  it('gives every page the clipboard the target grants, after a restart and a context reset too', async () => {
    const engine = await boot({ 'clipboard-read': 'grant', 'clipboard-write': 'grant' });
    try {
      expect(await copy(engine, 'first')).toBe('first');
      await engine.session!.restart!(operation());
      expect(await copy(engine, 'second')).toBe('second');
      await engine.session!.reset!(operation());
      expect(await copy(engine, 'third')).toBe('third');
    } finally {
      await shutdown(engine);
    }
  });

  it('leaves the clipboard refused when the target grants nothing', async () => {
    const engine = await boot();
    try {
      expect(await copy(engine, 'denied')).toMatch(/NotAllowedError/);
    } finally {
      await shutdown(engine);
    }
  });
});
