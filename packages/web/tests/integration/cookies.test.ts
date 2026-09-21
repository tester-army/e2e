/**
 * Configured cookies reach the app on every context the attempt opens: the
 * first one, the one a state reset replaces it with, and the one a saved
 * session is restored into, where the session's own cookie of the same name
 * keeps its value. Driven through the engine hooks, as the attempt executor
 * drives them; the fixture's `/cookies` page echoes the `Cookie` header, and a
 * second fixture instance reached as `localhost` stands in for another site.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-cookies', attemptId, origin: 'test' };
}

async function boot(engine: EngineHandle, app: FixtureApp, artifactsDir: string, attemptId: string): Promise<void> {
  await engine.init!({
    runId: 'run-cookies',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname },
    env: {},
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
  });
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
}

async function shutdown(engine: EngineHandle): Promise<void> {
  await engine.endAttempt!(cleanup());
  await engine.dispose!(cleanup());
}

/** Navigates to `/cookies` and reads the `Cookie` header the page echoes, `none` when the request carried none. */
async function cookiesSentTo(engine: EngineHandle, attemptId: string, origin: string): Promise<string> {
  await engine.session!.open!(`${origin}/cookies`, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('web({ cookies })', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    [app, other] = await Promise.all([startFixtureApp(), startFixtureApp()]);
    other = { ...other, url: other.url.replace('127.0.0.1', 'localhost') };
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cookies-'));
  });

  afterAll(async () => {
    await Promise.all([app.close(), other.close()]);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('sends the cookies on the first request of a sessionless attempt, and again after a state reset', async () => {
    const engine = web({
      url: app.url,
      cookies: [
        { url: app.url, name: 'om_demo_notice_ack', value: 'ack', sameSite: 'Lax' },
        { url: app.url, name: 'om_cookie_notice_ack', value: 'ack', sameSite: 'Lax' },
      ],
    });
    try {
      await boot(engine, app, artifactsDir, 'c1');
      const first = await cookiesSentTo(engine, 'c1', app.url);
      expect(first).toContain('om_demo_notice_ack=ack');
      expect(first).toContain('om_cookie_notice_ack=ack');
      // A state reset replaces the context; the fresh one is seeded too.
      await engine.session!.reset!(operation('c1'));
      const afterReset = await cookiesSentTo(engine, 'c1', app.url);
      expect(afterReset).toContain('om_demo_notice_ack=ack');
      expect(afterReset).toContain('om_cookie_notice_ack=ack');
    } finally {
      await shutdown(engine);
    }
  });

  it('targets the app url when a cookie names none, and no other site', async () => {
    const engine = web({ url: app.url, cookies: [{ name: 'om_feedback_suppress', value: '1' }] });
    try {
      await boot(engine, app, artifactsDir, 'c2');
      expect(await cookiesSentTo(engine, 'c2', app.url)).toBe('om_feedback_suppress=1');
      expect(await cookiesSentTo(engine, 'c2', other.url)).toBe('none');
    } finally {
      await shutdown(engine);
    }
  });

  it("keeps a restored session's cookie over the configured one of the same name", async () => {
    const engine = web({
      url: app.url,
      cookies: [
        { name: 'ack', value: 'from-config' },
        { name: 'only-configured', value: 'yes' },
      ],
    });
    try {
      await boot(engine, app, artifactsDir, 'c3');
      expect(await cookiesSentTo(engine, 'c3', app.url)).toContain('ack=from-config');
      // The signed-in state a setup test would save: the same cookie, set by the app.
      await surfaceOf(engine)!.context().addCookies([{ url: app.url, name: 'ack', value: 'from-session' }]);
      const session = await engine.state!.capture(operation('c3'));
      await engine.session!.reset!(operation('c3'));
      expect(await cookiesSentTo(engine, 'c3', app.url)).toContain('ack=from-config');
      await engine.state!.restore(session, operation('c3'));
      const restored = await cookiesSentTo(engine, 'c3', app.url);
      expect(restored).toContain('ack=from-session');
      expect(restored).not.toContain('from-config');
      expect(restored).toContain('only-configured=yes');
    } finally {
      await shutdown(engine);
    }
  });
});
