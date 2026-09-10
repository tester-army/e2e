/**
 * Reaching an app behind a gate: configured request headers and basic-auth
 * credentials reach the allowed origin on every context the attempt opens,
 * and never any other origin. Driven through the engine hooks, as the
 * attempt executor drives them; a second fixture instance stands in for a
 * third-party origin.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from '@e2edev/e2e/engine';
import { playwright, surfaceOf } from '../../src/index.ts';
import { PROTECTED_CREDENTIAL, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-protected', attemptId };
}

async function boot(engine: EngineHandle, app: FixtureApp, artifactsDir: string, attemptId: string): Promise<void> {
  await engine.init!({
    runId: 'run-protected',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
    testIdAttribute: 'data-testid',
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
  await engine.app!.navigate!(url, operation(attemptId));
  const nodes = await engine.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('playwright({ headers, basicAuth })', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    [app, other] = await Promise.all([startFixtureApp(), startFixtureApp()]);
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protected-'));
  });

  afterAll(async () => {
    await Promise.all([app.close(), other.close()]);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('sends the headers to the allowed origin only, on every context of the attempt', async () => {
    const engine = playwright({ url: app.url, headers: { 'X-Fixture-Header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h1');
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
      // A third-party origin gets the request without them.
      expect(await headingAt(engine, 'h1', `${other.url}/headers`)).toBe('none');
      // A state reset replaces the context; the headers come along.
      await engine.app!.clearState!(operation('h1'));
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers on a request an attempt route lets through', async () => {
    const engine = playwright({ url: app.url, headers: { 'x-fixture-header': 'through-the-route' } });
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

  it('answers a basic-auth challenge from the allowed origin and from no other', async () => {
    const unauthenticated = playwright({ url: app.url });
    try {
      await boot(unauthenticated, app, artifactsDir, 'b0');
      expect(await headingAt(unauthenticated, 'b0', `${app.url}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(unauthenticated);
    }
    const engine = playwright({ url: app.url, basicAuth: PROTECTED_CREDENTIAL });
    try {
      await boot(engine, app, artifactsDir, 'b1');
      expect(await headingAt(engine, 'b1', `${app.url}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b1', `${other.url}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(engine);
    }
  });
});
