/** Two observations at once take turns: neither supersedes the other's capture mid-flight. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Every node of a tree, including nested documents. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

it('captures both of two concurrent observations, and the refs of the last stay actionable', async () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-concurrent-observe-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'concurrent', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  try {
    await engine.init!({ runId: 'concurrent', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    const page = surfaceOf(engine)!.page();
    await page.setContent('<button onclick="document.body.dataset.clicked = \'yes\'">Press</button>');
    const [first, second] = await Promise.all([
      engine.observe!(operation, { pixels: true }),
      engine.observe!(operation, { pixels: true }),
    ]);
    expect(first.pixels).toBeDefined();
    expect(second.pixels).toBeDefined();
    const button = nodes(second.root).find((node) => node.role === 'button');
    expect(button).toBeDefined();
    await engine.perform!(button!.ref, { kind: 'tap' }, operation);
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBe('yes');
  } finally {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
