/** Public assert evidence must stop waiting while its caller and issued IO are still live. */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle, OperationContext } from '../../src/engine/index.ts';
import type { StoredArtifact } from '../../src/types.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { gate, hostHarness } from '../helpers/open-host.ts';

/** An unrelated descriptor remains usable after the original pending read safely closes. */
function isOpen(fd: number): boolean {
  try { fs.fstatSync(fd); return true; }
  catch (error) { expect(error).toMatchObject({ code: 'EBADF' }); return false; }
}

describe('public assert evidence operation deadline', () => {
  const { host, config } = hostHarness();
  it.each([true, false].flatMap((store) => [0, 120].map((captureDelay) => ({ store, captureDelay }))))(
    'abandons a never-callback read without renewing the budget, store=$store delay=$captureDelay',
    async ({ store, captureDelay }) => {
      const fake = createFakeEngine({ artifacts: true });
      let operation: OperationContext | undefined, started = 0, executorCalls = 0;
      const engine: EngineHandle = { ...fake.engine, artifacts: {
        ...fake.engine.artifacts!,
        async screenshot(label, context) {
          started = Date.now(); operation = context;
          if (captureDelay) await new Promise((resolve) => setTimeout(resolve, captureDelay));
          return fake.engine.artifacts!.screenshot(label, context);
        },
      } };
      const puts: StoredArtifact[] = [];
      const opened = await host(engine, { config: config(engine, {
        actionTimeout: 180, cache: 'off',
        ...(store ? { artifacts: { store: { async put(row: StoredArtifact) { puts.push(row); return { ref: row.sha256 }; } } } } : {}),
        agents: { default: { executor: { name: 'deadline-control', async runStep() {
          executorCalls++; return { status: 'passed' as const, summary: 'passed' };
        } } } },
      }) });
      const session = await opened.openSession({ name: 'stalled evidence', timeout: 5000 });
      const originalCreate = fs.createReadStream, realRead = fs.read, realClose = fs.close;
      const firstRead = gate();
      let stream: fs.ReadStream | undefined, originalFD: number | undefined, unrelatedFD: number | undefined;
      let drain: (() => Promise<void>) | undefined, pending = 0, reads = 0;
      const closes: { fd: number; pending: number }[] = [];
      const create = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
        if (typeof options !== 'object' || options === null || typeof options.fd !== 'number' || options.autoClose !== false) return originalCreate(file, options);
        originalFD = options.fd;
        stream = originalCreate(file, { ...options, fs: { ...fs,
          read(fd, buffer, offset, length, position, callback) {
            pending++; reads++;
            // No callback at all during the budget witness. Only harness cleanup issues the genuine read.
            drain = () => new Promise<void>((resolve) => realRead(fd, buffer, offset, length, position, (error, count, data) => {
              pending--; callback(error, count, data); resolve();
            }));
            firstRead.resolve();
          },
          close(fd, callback) { closes.push({ fd, pending }); realClose(fd, callback); },
        } });
        return stream;
      });
      syncBuiltinESMExports();
      const assertion = session.fixtures.agent.assert('passed verdict', { timeout: 3000 });
      void assertion.catch(() => undefined);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await firstRead.promise;
        const returned = await Promise.race([
          assertion.then(() => true),
          new Promise<boolean>((resolve) => { watchdog = setTimeout(() => resolve(false), Math.max(0, started + 230 - Date.now())); }),
        ]);
        expect(returned).toBe(true);
        expect(operation!.signal.aborted).toBe(false);
        expect(Date.now() - started).toBeLessThan(230);
        expect(operation!.timeoutMs).toBe(180);
        expect(pending).toBe(1); expect(reads).toBe(1);
        expect(stream!.destroyed).toBe(true); expect(stream!.closed).toBe(false);
        expect(closes).toEqual([]); expect(isOpen(originalFD!)).toBe(true);
        unrelatedFD = fs.openSync(path.join(session.artifactsDir, 'screenshots/fake.png'), 'r');
        expect(unrelatedFD).not.toBe(originalFD);
        expect(session.steps().at(-1)?.artifacts).toEqual([]);
        expect(puts).toEqual([]); expect(executorCalls).toBe(1);
        // Late original bytes cannot register, publish or redispatch after the evidence window ended.
        const closed = new Promise<void>((resolve) => stream!.once('close', resolve));
        await drain!(); await closed;
        expect(closes).toEqual([{ fd: originalFD, pending: 0 }]);
        expect(isOpen(unrelatedFD)).toBe(true);
        expect(session.steps().at(-1)?.artifacts).toEqual([]);
        expect(puts).toEqual([]); expect(executorCalls).toBe(1); expect(reads).toBe(1);
        expect(await session.close()).toEqual([]);
        expect(session.exportDebugBundle()!.artifacts).toEqual([]);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
        stream?.destroy();
        if (pending > 0) {
          const closed = new Promise<void>((resolve) => stream!.once('close', resolve));
          await drain!(); await closed;
        }
        await assertion.catch(() => undefined);
        create.mockRestore(); syncBuiltinESMExports();
        if (unrelatedFD !== undefined && isOpen(unrelatedFD)) fs.closeSync(unrelatedFD);
      }
    },
  );
});
