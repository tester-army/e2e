/**
 * Reaching an app behind a gate: configured request headers reach the app's
 * site on every context the attempt opens, and never another site; basic-auth
 * credentials answer a challenge wherever one is issued, as Playwright's own
 * do. Driven through the engine hooks, as the attempt executor drives them; a
 * second fixture instance reached as `localhost` rather than `127.0.0.1`
 * stands in for a third-party site.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { PROTECTED_CREDENTIAL, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-protected', attemptId, origin: 'test' };
}

async function boot(engine: EngineHandle, app: FixtureApp, artifactsDir: string, attemptId: string): Promise<void> {
  await engine.init!({
    runId: 'run-protected',
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

/** Navigates and reads the page's one heading. */
async function headingAt(engine: EngineHandle, attemptId: string, url: string): Promise<string> {
  await engine.session!.open!(url, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('web({ headers, basicAuth })', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    [app, other] = await Promise.all([startFixtureApp(), startFixtureApp()]);
    // The same loopback server under another host name: `localhost` is a
    // site of its own, `127.0.0.1` another.
    other = { ...other, url: other.url.replace('127.0.0.1', 'localhost') };
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protected-'));
  });

  afterAll(async () => {
    await Promise.all([app.close(), other.close()]);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('sends the headers to the app\'s site only, on every context of the attempt', async () => {
    const engine = web({ url: app.url, headers: { 'X-Fixture-Header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h1');
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
      // A third-party site gets the request without them.
      expect(await headingAt(engine, 'h1', `${other.url}/headers`)).toBe('none');
      // A state reset replaces the context; the headers come along.
      await engine.session!.reset!(operation('h1'));
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers on a request an attempt route lets through', async () => {
    const engine = web({ url: app.url, headers: { 'x-fixture-header': 'through-the-route' } });
    try {
      await boot(engine, app, artifactsDir, 'h2');
      let routed = 0;
      // Registered after the header route, so it runs first, as a `web.route` handler does.
      await surfaceOf(engine)!.context().route('**/headers', async (route) => {
        routed += 1;
        await route.fallback();
      });
      expect(await headingAt(engine, 'h2', `${app.url}/headers`)).toBe('through-the-route');
      expect(routed).toBe(1);
    } finally {
      await shutdown(engine);
    }
  });

  it('blocks service workers under headers, since routing never sees a worker\'s requests', async () => {
    // Registers the fixture's worker and counts what the browser now holds:
    // a blocked registration resolves like a real one but registers nothing.
    const registrations = async (): Promise<number> => {
      await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    };
    const plain = web({ url: app.url });
    try {
      await boot(plain, app, artifactsDir, 's0');
      await headingAt(plain, 's0', `${app.url}/`);
      // The fixture itself can register one: 127.0.0.1 is a secure context.
      expect(await surfaceOf(plain)!.page().evaluate(registrations)).toBe(1);
    } finally {
      await shutdown(plain);
    }
    const engine = web({ url: app.url, headers: { 'x-fixture-header': 'no-workers' } });
    try {
      await boot(engine, app, artifactsDir, 's1');
      await headingAt(engine, 's1', `${app.url}/`);
      expect(await surfaceOf(engine)!.page().evaluate(registrations)).toBe(0);
    } finally {
      await shutdown(engine);
    }
  });

  it('answers a basic-auth challenge wherever one is issued', async () => {
    const unauthenticated = web({ url: app.url });
    try {
      await boot(unauthenticated, app, artifactsDir, 'b0');
      expect(await headingAt(unauthenticated, 'b0', `${app.url}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(unauthenticated);
    }
    const engine = web({ url: app.url, basicAuth: PROTECTED_CREDENTIAL });
    try {
      await boot(engine, app, artifactsDir, 'b1');
      expect(await headingAt(engine, 'b1', `${app.url}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b1', `${other.url}/protected`)).toBe('Protected');
    } finally {
      await shutdown(engine);
    }
  });
});
