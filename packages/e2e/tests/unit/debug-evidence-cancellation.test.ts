/** Genuine source/built ticket cancellation with issued reads withheld until harness drain. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import * as source from '../../src/run/artifacts.ts';
import * as built from '../../dist/run/artifacts.js';
import { sessionSecrecy } from '../../src/run/secrecy.ts';
import { sessionSecrecy as builtSecrecy } from '../../dist/run/secrecy.js';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { StoredArtifact } from '../../src/types.ts';

for (const [route, sdk] of [['source', source], ['built', built]] as const) {
  describe(route + ' stalled evidence cancellation', () => {
    it.each([true, false].flatMap((store) => ['deadline', 'abort-finite', 'abort-infinite', 'abort-prefetch'].map((mode) => ({ store, mode }))))(
      'fences late bytes and preserves the issued FD, $mode store=$store', async ({ store, mode }) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-binding-cancel-'));
        const puts: StoredArtifact[] = [];
        const options = { artifactsRoot: root, segments: ['attempt'], attemptId: 'a', safePaths: true,
          ...(store ? { store: { async put(row: StoredArtifact) { puts.push(row); return { ref: row.sha256 }; } } } : {}),
        };
        const artifacts = sdk === source ? (() => {
          const secrecy = sessionSecrecy({} as TargetSession, new Map());
          return source.createAttemptArtifacts({ ...options, secrecy: () => secrecy });
        })() : (() => {
          const secrecy = builtSecrecy({} as TargetSession, new Map());
          return built.createAttemptArtifacts({ ...options, secrecy: () => secrecy });
        })();
        const bytes = Buffer.alloc(131072, 7);
        const filename = path.join(artifacts.dir, 'original.txt'); fs.writeFileSync(filename, bytes);
        const ticket = sdk.debugEvidenceRegistration(artifacts.sink, 'text');
        const controller = new AbortController(), reason = new Error('caller-owned reason');
        const realCreate = fs.createReadStream, realRead = fs.read, realClose = fs.close;
        const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
        let stream: fs.ReadStream | undefined, fd: number | undefined, other: number | undefined;
        let pending = 0, reads = 0, drain: (() => Promise<void>) | undefined;
        const closes: { fd: number; pending: number }[] = [];
        let cancelTimer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
        const create = vi.spyOn(fs, 'createReadStream').mockImplementation((file, opts) => {
          if (typeof opts !== 'object' || opts === null || typeof opts.fd !== 'number') throw new Error('expected numeric FD');
          fd = opts.fd;
          stream = realCreate(file, { ...opts, fs: { ...fs,
            read(descriptor, buffer, offset, length, position, callback) {
              pending++; reads++;
              const dispatch = () => new Promise<void>((resolve) => realRead(descriptor, buffer, offset, length, position, (error, count, data) => {
                pending--; callback(error, count, data); resolve();
              }));
              if (mode === 'abort-prefetch' && reads === 1) { void dispatch(); return; }
              drain = dispatch;
              if (mode !== 'deadline') cancelTimer = realTimeout(() => controller.abort(reason), 20);
            },
            close(descriptor, callback) { closes.push({ fd: descriptor, pending }); realClose(descriptor, callback); },
          } });
          return stream;
        });
        const syncClose = vi.spyOn(fs, 'closeSync');
        const firedTimers = new Set<ReturnType<typeof setTimeout>>();
        const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
          const handle = realTimeout(() => { firedTimers.add(handle); callback(...args); }, delay);
          return handle;
        });
        const clears = vi.spyOn(globalThis, 'clearTimeout');
        syncBuiltinESMExports();
        const binding = sdk.bindDebugEvidenceFile(artifacts.sink, 'original.txt', ticket, controller.signal,
          mode === 'abort-infinite' ? Infinity : Date.now() + (mode === 'deadline' ? 50 : 200));
        try {
          const returned = await Promise.race([binding.then(() => true), new Promise<boolean>((resolve) => {
            watchdog = realTimeout(() => resolve(false), 100);
          })]);
          expect(returned).toBe(true);
          expect(controller.signal.aborted).toBe(mode !== 'deadline');
          if (mode !== 'deadline') expect(controller.signal.reason).toBe(reason);
          expect(pending).toBe(1); expect(reads).toBe(mode === 'abort-prefetch' ? 2 : 1);
          expect(syncClose).not.toHaveBeenCalled(); expect(closes).toEqual([]);
          expect(stream!.destroyed).toBe(true); expect(stream!.closed).toBe(false);
          const ownedTimers = timers.mock.results.map((result) => result.value);
          if (mode === 'abort-infinite') expect(ownedTimers).toHaveLength(0);
          else expect(ownedTimers.length).toBeGreaterThanOrEqual(1);
          // An early timer dispatch may rearm against the SAME absolute deadline.
          for (const timer of ownedTimers) {
            expect(firedTimers.has(timer) || clears.mock.calls.some(([cleared]) => cleared === timer)).toBe(true);
          }
          timers.mockRestore(); clears.mockRestore();
          other = fs.openSync(filename, 'r'); expect(other).not.toBe(fd);
          expect(sdk.debugEvidenceProven(artifacts.sink, ticket)).toBe(false);
          const closed = new Promise<void>((resolve) => stream!.once('close', resolve));
          await drain!(); await closed; await binding;
          expect(closes).toEqual([{ fd, pending: 0 }]);
          expect(fs.fstatSync(other).size).toBe(bytes.length);
          expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
          expect(reads).toBe(mode === 'abort-prefetch' ? 2 : 1);
          // Even the byte-binding helper cannot revive the original cancelled capture ticket.
          sdk.bindDebugEvidenceBytes(artifacts.sink, ticket, bytes);
          expect(sdk.debugEvidenceBytesProven(artifacts.sink, ticket, bytes)).toBe(false);
          create.mockRestore(); syncClose.mockRestore(); syncBuiltinESMExports();
          const id = artifacts.sink.register('log', 'original.txt', ticket); await artifacts.settle();
          expect(artifacts.debugRedactionProven(id)).toBe(false); expect(puts).toEqual([]);
          expect(artifacts.records[0]).not.toHaveProperty('path');
          expect(artifacts.records[0]).not.toHaveProperty('sha256');
        } finally {
          if (cancelTimer !== undefined) realClear(cancelTimer);
          if (watchdog !== undefined) realClear(watchdog);
          stream?.destroy();
          if (pending > 0) {
            const closed = new Promise<void>((resolve) => stream!.once('close', resolve));
            await drain!(); await closed;
          }
          await binding;
          create.mockRestore(); syncClose.mockRestore(); timers.mockRestore(); clears.mockRestore(); syncBuiltinESMExports();
          if (other !== undefined) fs.closeSync(other);
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it.each(['eof', 'read-error', 'construct-throw'] as const)('cleans deadline timers and listeners on %s', async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-binding-finish-'));
      const options = { artifactsRoot: root, segments: ['attempt'], attemptId: 'a', safePaths: true };
      const artifacts = sdk === source ? (() => {
        const secrecy = sessionSecrecy({} as TargetSession, new Map());
        return source.createAttemptArtifacts({ ...options, secrecy: () => secrecy });
      })() : (() => {
        const secrecy = builtSecrecy({} as TargetSession, new Map());
        return built.createAttemptArtifacts({ ...options, secrecy: () => secrecy });
      })();
      fs.writeFileSync(path.join(artifacts.dir, 'original.txt'), 'complete');
      const ticket = sdk.debugEvidenceRegistration(artifacts.sink, 'text');
      const controller = new AbortController();
      const realCreate = fs.createReadStream, realRead = fs.read;
      let stream: fs.ReadStream | undefined;
      const create = vi.spyOn(fs, 'createReadStream').mockImplementation((file, opts) => {
        if (mode === 'construct-throw') throw new Error('construction failed');
        stream = realCreate(file, { ...(typeof opts === 'object' ? opts : {}), fs: { ...fs,
          read(fd, buffer, offset, length, position, callback) {
            realRead(fd, buffer, offset, length, position, (error, count, data) => {
              callback(mode === 'read-error' ? Object.assign(new Error('read failed'), { code: 'EIO' }) : error, count, data);
            });
          },
        } });
        return stream;
      });
      const timers = vi.spyOn(globalThis, 'setTimeout'), clears = vi.spyOn(globalThis, 'clearTimeout');
      syncBuiltinESMExports();
      try {
        await sdk.bindDebugEvidenceFile(artifacts.sink, 'original.txt', ticket, controller.signal, Date.now() + 200);
        const ownedTimers = timers.mock.results.map((result) => result.value);
        expect(ownedTimers).toHaveLength(mode === 'construct-throw' ? 0 : 1);
        for (const timer of ownedTimers) expect(clears).toHaveBeenCalledWith(timer);
        if (stream !== undefined && !stream.closed) await new Promise<void>((resolve) => stream!.once('close', resolve));
        expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
        expect(controller.signal.aborted).toBe(false);
        expect(sdk.debugEvidenceProven(artifacts.sink, ticket)).toBe(mode === 'eof');
      } finally {
        stream?.destroy();
        create.mockRestore(); timers.mockRestore(); clears.mockRestore(); syncBuiltinESMExports();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
