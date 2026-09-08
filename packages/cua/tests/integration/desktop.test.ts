/**
 * The cua engine against the real desktop: TextEdit through the in-process
 * Cua Driver runtime. Opt in with `E2E_CUA_DESKTOP=1`; the process needs
 * Accessibility (and Screen Recording for the pixel assertions). Skipped
 * loudly otherwise, so a CI run without grants never reads as a pass.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle, OperationContext, SemanticNode } from '@e2edev/e2e/engine';
import { cua } from '../../src/index.ts';

const enabled = process.env['E2E_CUA_DESKTOP'] === '1' && process.platform === 'darwin';

function operation(): OperationContext {
  return { signal: AbortSignal.timeout(60_000), timeoutMs: 60_000, runId: 'live', attemptId: 'a1' };
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

describe.skipIf(!enabled)('cua engine on the desktop (TextEdit)', () => {
  let engine: EngineHandle;
  let artifactsDir: string;

  beforeAll(async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cua-live-'));
    engine = cua({ app: 'com.apple.TextEdit', window: /Untitled/ });
    await engine.init!({
      runId: 'live',
      targetName: 'textedit',
      projectRoot: process.cwd(),
      app: { allowedOrigins: [] },
      testIdAttribute: 'data-testid',
      headed: true,
      signal: AbortSignal.timeout(60_000),
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: AbortSignal.timeout(60_000) });
  });

  afterAll(async () => {
    const cleanup = { signal: AbortSignal.timeout(20_000), timeoutMs: 20_000 };
    await engine?.endAttempt?.(cleanup);
    await engine?.dispose?.(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('observes the window as a tree with a text area, and anchors it', async () => {
    const snapshot = await engine.observe!(operation());
    const nodes = [...walk(snapshot.nodes)];
    expect(nodes.length).toBeGreaterThan(3);
    expect(snapshot.url).toMatch(/^app:\/\/desktop\/com\.apple\.textedit\//);
    expect(snapshot.viewport?.width).toBeGreaterThan(100);
    const editor = nodes.find((node) => node.role === 'textbox');
    expect(editor, `roles seen: ${[...new Set(nodes.map((node) => node.role))].join(', ')}`).toBeDefined();
    expect(editor?.rect?.width).toBeGreaterThan(50);
  });

  it('fills the text area and reads the value back through locate', async () => {
    const query = { kind: 'query' as const, query: { kind: 'role' as const, value: { kind: 'string' as const, value: 'textbox', exact: false } } };
    const [editor] = await engine.locate!(query, operation());
    expect(editor).toBeDefined();
    await engine.perform!(editor!.ref, { kind: 'fill', value: 'Hello from e2e', sensitive: false }, operation());
    const [after] = await engine.locate!(query, operation());
    expect(after?.value).toBe('Hello from e2e');
    await engine.perform!(after!.ref, { kind: 'press', key: 'Enter' }, operation());
  });

  it('captures masked pixels and writes a screenshot artifact when Screen Recording is granted', async () => {
    const snapshot = await engine.observe!(operation(), { pixels: true });
    if (snapshot.pixels === undefined) {
      console.warn('no pixels: Screen Recording is not granted to this process; skipping the artifact check');
      return;
    }
    expect(snapshot.pixels.mediaType).toBe('image/png');
    expect(snapshot.pixels.scale).toBeGreaterThanOrEqual(1);
    const relative = await engine.artifacts!.screenshot('live', operation());
    expect(existsSync(path.join(artifactsDir, relative))).toBe(true);
  });

  it('restarts the app into a fresh untitled document', async () => {
    await engine.app!.restart!(operation());
    const snapshot = await engine.observe!(operation());
    expect(snapshot.url).toMatch(/Untitled/);
  });
});
