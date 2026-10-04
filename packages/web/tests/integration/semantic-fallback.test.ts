import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { web, surfaceOf } from '../../src/index.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreAppLog, noSecrets } from '../helpers/secrets.ts';

/** Every semantic ref, including nested documents. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe('masked fallback after a stalled semantic reader', () => {
  it('reserves capture time and takes fresh masked pixels', async () => {
    const engine = web({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-fallback-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 2_000, runId: 'fallback', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'fallback', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, appLog: ignoreAppLog });
      await engine.session!.open!('about:blank', operation);
      const page = surfaceOf(engine)!.page();
      await page.setContent('<style>input{position:absolute;left:20px;top:20px;width:100px;height:30px;border:0;padding:0;background:red}</style><input data-testid="password" type="password" value="private-value">');
      const old = await engine.observe!(operation);
      const [password] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, operation);
      expect(password).toBeDefined();
      await page.evaluate(() => { setTimeout(() => { document.body.style.background = 'blue'; }, 1_000); });
      const reader = vi.spyOn(page, 'evaluateHandle').mockImplementation(() => new Promise(() => undefined));
      try {
        const started = Date.now();
        const fallback = await engine.observe!(operation, { pixels: true, pixelFallback: true });
        expect(Date.now() - started).toBeGreaterThan(1_250);
        expect(Date.now() - started).toBeLessThan(operation.timeoutMs);
        expect(fallback.treeUnavailable).toBe(true);
        expect(fallback.root).toEqual({ ref: { id: old.root.ref.id, revision: '' } });
        expect(fallback.maskedRegionCount).toBeGreaterThanOrEqual(1);
        const image = decodePng(fallback.pixels!.data);
        expect(image.pixelAt(40, 30)).toEqual([0, 0, 0, 255]);
        expect(image.pixelAt(200, 100)).toEqual([0, 0, 255, 255]);
        await expect(engine.perform!(password!.ref, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
      } finally {
        reader.mockRestore();
      }
    } finally {
      await engine.endAttempt!(cleanup);
      await engine.dispose!(cleanup);
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it('keeps abandoned reader IDs distinct from new nodes, frames, and located refs', async () => {
    const engine = web({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-ids-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 5_000, runId: 'ids', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'ids', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, appLog: ignoreAppLog });
      await engine.session!.open!('about:blank', operation);
      const page = surfaceOf(engine)!.page();
      await page.setContent('<button data-testid="a" onclick="document.body.dataset.clicked=\'A\'">Button A</button>');
      await engine.observe!(operation);
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Button B';
        button.addEventListener('click', () => { document.body.dataset.clicked = 'B'; });
        document.body.append(button);
      });
      let release!: () => void;
      const reply = new Promise<void>((resolve) => { release = resolve; });
      const original = page.evaluateHandle.bind(page);
      const reader = vi.spyOn(page, 'evaluateHandle').mockImplementation(async (...args) => {
        const captured = await original(...args);
        // The real reader stamped B already; only its protocol reply is delayed.
        await reply;
        return captured;
      });
      try {
        const fallback = await engine.observe!({ ...operation, timeoutMs: 2_000 }, { pixelFallback: true });
        expect(fallback.treeUnavailable).toBe(true);
      } finally {
        reader.mockRestore();
        release();
      }
      const [located] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'a', exact: true } } }, operation);
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Button C';
        button.addEventListener('click', () => { document.body.dataset.clicked = 'C'; });
        document.body.prepend(button);
        const frame = document.createElement('iframe');
        frame.srcdoc = '<button onclick="document.body.dataset.clicked=\'D\'">Button D</button>';
        document.body.append(frame);
      });
      await page.frameLocator('iframe').getByRole('button', { name: 'Button D' }).waitFor();
      const fresh = await engine.observe!(operation);
      const observed = nodes(fresh.root);
      const ids = observed.map((node) => node.ref.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(located).toBeDefined();
      expect(ids).not.toContain(located!.ref.id);
      for (const name of ['Button B', 'Button C', 'Button D']) {
        const target = observed.find((node) => node.name === name);
        expect(target, name).toBeDefined();
        await engine.perform!(target!.ref, { kind: 'tap' }, operation);
        const clicked = name === 'Button D'
          ? await page.frameLocator('iframe').locator('body').getAttribute('data-clicked')
          : await page.locator('body').getAttribute('data-clicked');
        expect(clicked).toBe(name.slice(-1));
      }
    } finally {
      await engine.endAttempt!(cleanup);
      await engine.dispose!(cleanup);
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
