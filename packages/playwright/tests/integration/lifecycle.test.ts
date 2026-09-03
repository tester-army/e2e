/**
 * The playwright backend's lifecycle through the public contract: one shared
 * browser per backend, one context per attempt, and honest idempotent
 * teardown. No runner involved - the hooks are driven directly, the way the
 * attempt executor drives them.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackendCleanupContext,
  BackendHandle,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from '@e2edev/e2e/backend';
import { playwright } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { decodePng } from '../helpers/png.ts';

function cleanup(signal = new AbortController().signal): BackendCleanupContext {
  return { signal, timeoutMs: 30_000 };
}

function operation(attemptId: string, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-pool', attemptId };
}

function attempt(attemptId: string, artifactsDir: string) {
  return { attemptId, artifactsDir, signal: new AbortController().signal };
}

function byRole(role: string): LocatorExpression {
  return { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: role, exact: true } } };
}

/** Depth-first walk of one observation tree. */
function* walk(node: SemanticNode): Generator<SemanticNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

/** Runs one attempt on a booted backend and always tears it down. */
async function withAttempt(
  backend: BackendHandle,
  app: FixtureApp,
  artifactsDir: string,
  attemptId: string,
  body: () => Promise<void>,
): Promise<void> {
  await boot(backend, app);
  try {
    await backend.startAttempt!(attempt(attemptId, artifactsDir));
    await body();
  } finally {
    await backend.endAttempt!(cleanup());
    await backend.dispose!(cleanup());
  }
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
  await backend.app!.navigate!(`${app.url}/`, operation(attemptId));
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
      await backend.endAttempt!(cleanup());
      // The next attempt reuses the pooled browser process, not a new launch.
      expect(await openAttempt(backend, app, artifactsDir, 'a2')).toBe('Home');
      await backend.endAttempt!(cleanup());
    } finally {
      await backend.dispose!(cleanup());
    }
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const backend = playwright();
    await boot(backend, app);
    await openAttempt(backend, app, artifactsDir, 'b1');
    await backend.endAttempt!(cleanup());
    await backend.dispose!(cleanup());
    await backend.dispose!(cleanup());

    await boot(backend, app);
    try {
      expect(await openAttempt(backend, app, artifactsDir, 'b2')).toBe('Home');
    } finally {
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
    }
  });

  it('observes a semantic tree and locates by display value in one round trip', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      await backend.startAttempt!({ attemptId: 'd1', artifactsDir, signal: new AbortController().signal });
      await backend.app!.navigate!(`${app.url}/form`, operation('d1'));

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
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
    }
  });

  it('reports an unopened page as INVALID_STATE, never as a missing node', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      await backend.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal });
      await expect(backend.observe!(operation('c1'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally {
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
    }
  });

  it('refuses a second startAttempt while one is running and keeps the first intact', async () => {
    const backend = playwright();
    await withAttempt(backend, app, artifactsDir, 'e1', async () => {
      await expect(backend.startAttempt!(attempt('e2', artifactsDir))).rejects.toMatchObject({
        code: 'INVALID_STATE',
        retryable: false,
      });
      await backend.app!.navigate!(`${app.url}/`, operation('e1'));
      expect(await backend.url!(operation('e1'))).toBe(`${app.url}/`);
    });
  });

  it('treats endAttempt before startAttempt and dispose on a cold backend as no-ops', async () => {
    const cold = playwright();
    await expect(cold.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(cold.dispose!(cleanup())).resolves.toBeUndefined();

    const backend = playwright();
    try {
      await boot(backend, app);
      await expect(backend.endAttempt!(cleanup())).resolves.toBeUndefined();
      expect(await openAttempt(backend, app, artifactsDir, 'f1')).toBe('Home');
    } finally {
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
    }
  });

  it('stops waiting on cleanup once its budget is aborted, and recovers on the next attempt', async () => {
    const backend = playwright();
    try {
      await boot(backend, app);
      expect(await openAttempt(backend, app, artifactsDir, 'g1')).toBe('Home');
      const exhausted = new AbortController();
      exhausted.abort();
      await expect(backend.endAttempt!({ signal: exhausted.signal, timeoutMs: 0 })).resolves.toBeUndefined();
      expect(await openAttempt(backend, app, artifactsDir, 'g2')).toBe('Home');
    } finally {
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
    }
  });

  it('cancels an in-flight operation when its signal aborts instead of waiting out Playwright', async () => {
    const backend = playwright();
    await withAttempt(backend, app, artifactsDir, 'h1', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = backend.app!.navigate!(`${app.url}/slow`, operation('h1', controller.signal));
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it('round-trips persisted state through capture and restore, and clearState drops it', async () => {
    const backend = playwright();
    await withAttempt(backend, app, artifactsDir, 's1', async () => {
      const token = async (): Promise<string> => {
        const [heading] = await backend.locate!(byRole('heading'), operation('s1'));
        return heading?.name ?? '';
      };
      await backend.app!.navigate!(`${app.url}/state?set=abc`, operation('s1'));
      expect(await token()).toBe('abc');
      const state = await backend.state!.capture(operation('s1'));
      expect(state.format).toBe('playwright-storage-state');

      await backend.app!.clearState!(operation('s1'));
      await backend.app!.navigate!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('none');

      await backend.state!.restore(state, operation('s1'));
      await backend.app!.navigate!(`${app.url}/state`, operation('s1'));
      expect(await token()).toBe('abc');

      await expect(
        backend.state!.restore({ format: 'playwright-storage-state', version: 1, data: '/etc/passwd' }, operation('s1')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });
  });

  it('reports a ref from a superseded observation as NODE_STALE', async () => {
    const backend = playwright();
    await withAttempt(backend, app, artifactsDir, 'o1', async () => {
      await backend.app!.navigate!(`${app.url}/form`, operation('o1'));
      const first = await backend.observe!(operation('o1'));
      const textbox = [...walk(first.nodes[0]!)].find((node) => node.role === 'textbox');
      expect(textbox).toBeDefined();
      await backend.perform!(textbox!.ref, { kind: 'fill', value: 'fresh', sensitive: false }, operation('o1'));

      await backend.observe!(operation('o1'));
      await expect(
        backend.perform!(textbox!.ref, { kind: 'fill', value: 'late', sensitive: false }, operation('o1')),
      ).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    });
  });

  it('keeps tracing across clearState: the earlier segment is kept and the trace still stops', async () => {
    const backend = playwright();
    const traceDir = mkdtempSync(path.join(tmpdir(), 'e2e-trace-'));
    try {
      await withAttempt(backend, app, traceDir, 't1', async () => {
        await backend.artifacts!.startTrace!(operation('t1'));
        await backend.app!.navigate!(`${app.url}/`, operation('t1'));
        await backend.app!.clearState!(operation('t1'));
        await backend.app!.navigate!(`${app.url}/form`, operation('t1'));
        const relative = await backend.artifacts!.stopTrace!(operation('t1'));
        expect(relative).toBe('trace/trace.zip');
        for (const file of [relative, 'trace/trace-part1.zip']) {
          const absolute = path.join(traceDir, file);
          expect(existsSync(absolute), file).toBe(true);
          expect(statSync(absolute).size).toBeGreaterThan(0);
          expect(readFileSync(absolute).subarray(0, 2).toString('latin1')).toBe('PK');
        }
      });
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it('masks secure fields in artifact screenshots and restarts the counter per attempt', async () => {
    const backend = playwright();
    const shotDir = mkdtempSync(path.join(tmpdir(), 'e2e-shot-'));
    try {
      await boot(backend, app);
      await backend.startAttempt!(attempt('m1', shotDir));
      await backend.app!.navigate!(`${app.url}/login`, operation('m1'));
      expect(await backend.artifacts!.screenshot('first', operation('m1'))).toBe('screenshots/001-first.png');
      await backend.endAttempt!(cleanup());

      await backend.startAttempt!(attempt('m2', shotDir));
      await backend.app!.navigate!(`${app.url}/login`, operation('m2'));
      const nodes = await backend.locate!(byRole('textbox'), operation('m2'));
      const user = nodes.find((node) => node.name === 'User');
      expect(user?.rect).toBeDefined();
      const [password] = await backend.locate!({ kind: 'selector', selector: 'input[type=password]' }, operation('m2'));
      expect(password?.rect).toBeDefined();
      await backend.perform!(password!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, operation('m2'));

      const relative = await backend.artifacts!.screenshot('login', operation('m2'));
      expect(relative).toBe('screenshots/001-login.png');
      const image = decodePng(new Uint8Array(readFileSync(path.join(shotDir, relative))));
      const centre = (rect: NonNullable<SemanticNode['rect']>) =>
        [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] as const;
      const [px, py] = centre(password!.rect!);
      const [ux, uy] = centre(user!.rect!);
      // The password field is covered by the opaque mask; the plain field is not.
      expect(image.pixelAt(px, py).slice(0, 3)).toEqual([0, 0, 0]);
      expect(image.pixelAt(ux, uy).slice(0, 3)).toEqual([255, 255, 255]);
    } finally {
      await backend.endAttempt!(cleanup());
      await backend.dispose!(cleanup());
      rmSync(shotDir, { recursive: true, force: true });
    }
  });
});
