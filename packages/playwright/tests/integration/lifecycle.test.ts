/**
 * The playwright backend's lifecycle through the public contract: one shared
 * browser per backend, one context per attempt, and honest idempotent
 * teardown. No runner involved - the hooks are driven directly, the way the
 * attempt executor drives them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendHandle, OperationContext } from 'e2e/backend';
import { playwright } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-pool', attemptId };
}

async function boot(backend: BackendHandle, app: FixtureApp): Promise<void> {
  await backend.init!({
    runId: 'run-pool',
    targetName: 'web',
    app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
}

async function openAttempt(
  backend: BackendHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
): Promise<string> {
  await backend.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
  await backend.actions!.navigate!(`${app.url}/`, operation(attemptId));
  const nodes = await backend.locate!(
    { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

describe('playwright backend lifecycle', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-pool-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('declares the full deterministic tier plus the web fixture', () => {
    const backend = playwright();
    expect([...backend.capabilities].toSorted()).toEqual([
      'actions',
      'artifacts',
      'location',
      'observation',
      'state',
      'web',
    ]);
    expect(backend.name).toBe('playwright');
  });

  it('serves consecutive attempts from one browser and survives an attempt close', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      expect(await openAttempt(backend, app, artifactsDir, 'a1')).toBe('Home');
      expect(await backend.url!(operation('a1'))).toBe(`${app.url}/`);
      await backend.endAttempt!();
      // The next attempt reuses the pooled browser process, not a new launch.
      expect(await openAttempt(backend, app, artifactsDir, 'a2')).toBe('Home');
      await backend.endAttempt!();
    } finally {
      await backend.dispose!();
    }
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const backend = playwright();
    await boot(backend, app);
    await openAttempt(backend, app, artifactsDir, 'b1');
    await backend.endAttempt!();
    await backend.dispose!();
    await backend.dispose!();

    await boot(backend, app);
    try {
      expect(await openAttempt(backend, app, artifactsDir, 'b2')).toBe('Home');
    } finally {
      await backend.endAttempt!();
      await backend.dispose!();
    }
  });

  it('observes a semantic tree and locates by display value in one round trip', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      await backend.startAttempt!({ attemptId: 'd1', artifactsDir, signal: new AbortController().signal });
      await backend.actions!.navigate!(`${app.url}/form`, operation('d1'));

      const snapshot = await backend.observe!(operation('d1'));
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]?.children?.length ?? 0).toBeGreaterThan(0);
      expect(snapshot.viewport).toEqual({ width: 1280, height: 720, scale: 1 });

      // displayValue is filtered from the values the batch read returned:
      // two inputs hold "alpha", one holds "beta".
      const alphas = await backend.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'alpha', exact: true } } },
        operation('d1'),
      );
      expect(alphas.map((node) => node.value)).toEqual(['alpha', 'alpha']);
      const betas = await backend.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'beta', exact: true } } },
        operation('d1'),
      );
      expect(betas).toHaveLength(1);
      // A single-match ref performs against the strict locator.
      await backend.perform!(betas[0]!.ref, { kind: 'fill', value: 'gamma', sensitive: false }, operation('d1'));
      const gammas = await backend.locate!(
        { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'gamma', exact: true } } },
        operation('d1'),
      );
      expect(gammas.map((node) => node.name)).toEqual(['Second']);
    } finally {
      await backend.endAttempt!();
      await backend.dispose!();
    }
  });

  it('reports an unopened page as INVALID_STATE, never as a missing node', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      await backend.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal });
      await expect(backend.observe!(operation('c1'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      await backend.endAttempt!();
      await backend.dispose!();
    }
  });
});
