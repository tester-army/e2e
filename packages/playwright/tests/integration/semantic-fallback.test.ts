import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { playwright, surfaceOf } from '../../src/index.ts';
import { decodePng } from '../helpers/png.ts';

describe('masked fallback after a stalled semantic reader', () => {
  it.each([false, true])('reserves capture time and takes fresh masked pixels (requested: %s)', async (pixels) => {
    const engine = playwright({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-fallback-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 4_000, runId: 'fallback', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'fallback', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal });
      await engine.session!.open!('about:blank', operation);
      const page = surfaceOf(engine)!.page();
      await page.setContent('<style>input{position:absolute;left:20px;top:20px;width:100px;height:30px;border:0;padding:0;background:red}</style><input data-testid="password" type="password" value="private-value">');
      const old = await engine.observe!(operation);
      const [password] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, operation);
      expect(password).toBeDefined();
      await page.evaluate(() => { setTimeout(() => { document.body.style.background = 'blue'; }, 1_500); });
      const reader = vi.spyOn(page, 'evaluateHandle').mockImplementation(() => new Promise(() => undefined));
      try {
        const started = Date.now();
        const fallback = await engine.observe!(operation, { pixels, pixelFallback: true });
        expect(Date.now() - started).toBeGreaterThan(2_500);
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
});
