/** Genuine SDK tickets and Linux/Node IO; no new capture or public export authority. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as source from '../../src/run/artifacts.ts';
import * as built from '../../dist/run/artifacts.js';
import { sessionSecrecy } from '../../src/run/secrecy.ts';
import { sessionSecrecy as builtSecrecy } from '../../dist/run/secrecy.js';
import type { TargetSession } from '../../src/engine/surface.ts';
import type { StoredArtifact } from '../../src/types.ts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The built route uses its own private secrecy registry, as real SDK callers do. */
function setup(sdk: typeof source | typeof built, store: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fd-lifecycle-')); roots.push(root);
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
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(artifacts.dir, 'original.txt'), bytes);
  fs.writeFileSync(path.join(root, 'replacement.txt'), 'unrelated');
  return { root, artifacts, puts, bytes };
}

/** Test oracle only: an eventual close permits reuse; a pending owner must not release its number. */
function isOpen(fd: number): boolean {
  try { fs.fstatSync(fd); return true; }
  catch (error) { expect(error).toMatchObject({ code: 'EBADF' }); return false; }
}

for (const [route, sdk] of [['source', source], ['built', built]] as const) {
  describe(route, () => {
    it.each([true, false].flatMap((store) =>
      ['deadline', 'abort-mid-read', 'read-error', 'eof'].map((mode) => ({ store, mode })),
    ))('has one stream FD owner through $mode, store=$store', async ({ store, mode }) => {
      const { root, artifacts, puts, bytes } = setup(sdk, store);
      const ticket = sdk.debugEvidenceRegistration(artifacts.sink, 'text');
      const controller = new AbortController();
      const realCreate = fs.createReadStream, realRead = fs.read, realClose = fs.close, realCloseSync = fs.closeSync;
      let stream: fs.ReadStream | undefined, originalFD: number | undefined, replacementFD: number | undefined;
      let pendingIO = 0, reads = 0, largestRead = 0;
      const syncCloses: { fd: number; pendingIO: number; destroyed: boolean; closed: boolean }[] = [];
      const asyncCloses: { fd: number; pendingIO: number }[] = [];
      const streamErrors: Error[] = [];
      const create = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
        expect(options).toMatchObject({ autoClose: false, highWaterMark: 65536, signal: controller.signal });
        if (typeof options !== 'object' || options === null || typeof options.fd !== 'number') throw new Error('expected binder FD options');
        originalFD = options.fd;
        stream = realCreate(file, { ...options, fs: {
          ...fs,
          read(fd, buffer, offset, length, position, callback) {
            pendingIO++; reads++; largestRead = Math.max(largestRead, length);
            const ordinal = reads;
            const dispatch = () => realRead(fd, buffer, offset, length, position, (error, count, data) => {
              pendingIO--;
              if (mode === 'read-error' && ordinal === 2) {
                callback(Object.assign(new Error('read failed'), { code: 'EIO' }), count, data);
              } else { callback(error, count, data); }
            });
            if (mode === 'abort-mid-read' && ordinal === 2) controller.abort();
            // Deliver the first chunk inside the deadline, then leave genuine prefetch pending.
            // A deadline now cancels before the old 100ms first chunk could arrive.
            if ((mode === 'deadline' && ordinal === 2) || mode === 'abort-mid-read') setTimeout(dispatch, 100);
            else dispatch();
          },
          close(fd, callback) {
            asyncCloses.push({ fd, pendingIO }); realClose(fd, callback);
          },
        } });
        stream.on('error', (error) => { streamErrors.push(error); });
        return stream;
      });
      const syncClose = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        syncCloses.push({ fd, pendingIO, destroyed: stream?.destroyed ?? false, closed: stream?.closed ?? false });
        realCloseSync(fd);
      });
      syncBuiltinESMExports();
      try {
        await sdk.bindDebugEvidenceFile(artifacts.sink, 'original.txt', ticket, controller.signal,
          mode === 'deadline' ? Date.now() + 50 : Infinity);
        const pendingAtReturn = pendingIO;
        const syncAtReturn = syncCloses.slice();
        replacementFD = fs.openSync(path.join(root, 'replacement.txt'), 'r');
        const reusedWhilePending = pendingAtReturn > 0 && replacementFD === originalFD;
        // Let already-issued Node cleanup finish BEFORE testing the unrelated descriptor.
        await new Promise((resolve) => setTimeout(resolve, 350));
        const replacementStillOpen = isOpen(replacementFD);
        const originalStillOpen = originalFD === replacementFD ? false : isOpen(originalFD!);
        console.log(JSON.stringify({ route, mode, store, pendingAtReturn, syncAtReturn, asyncCloses,
          reusedWhilePending, replacementStillOpen, originalStillOpen, reads, largestRead }));
        expect(replacementStillOpen).toBe(true);
        expect(reusedWhilePending).toBe(false);
        expect(syncCloses).toEqual([]);
        expect(asyncCloses).toEqual([{ fd: originalFD, pendingIO: 0 }]);
        expect(originalStillOpen).toBe(false);
        expect(stream?.closed).toBe(true);
        expect(largestRead).toBeLessThanOrEqual(65536);
        if (mode === 'deadline') {
          expect(controller.signal.aborted).toBe(false);
          expect(pendingAtReturn).toBe(1);
          expect(reads).toBe(2);
        }
        if (mode === 'abort-mid-read') {
          expect(controller.signal.aborted).toBe(true);
          expect(pendingAtReturn).toBe(1);
          expect(reads).toBe(2);
        }
        if (mode === 'eof') expect(streamErrors).toEqual([]);
        // Restore only IO observation, not the binder/ticket/measurement/Store.
        create.mockRestore(); syncClose.mockRestore(); syncBuiltinESMExports();
        expect(sdk.debugEvidenceProven(artifacts.sink, ticket)).toBe(mode === 'eof');
        expect(sdk.debugEvidenceBytesProven(artifacts.sink, ticket, bytes)).toBe(mode === 'eof');
        const id = artifacts.sink.register('log', 'original.txt', ticket); await artifacts.settle();
        expect(artifacts.debugRedactionProven(id)).toBe(mode === 'eof');
        expect(puts).toHaveLength(mode === 'eof' && store ? 1 : 0);
        if (mode === 'eof') {
          expect(artifacts.records[0]).toMatchObject({ size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') });
          expect(artifacts.debugMediaType(id)).toBe('text/plain');
          if (store) expect(Buffer.from(puts[0]!.bytes)).toEqual(bytes);
        } else {
          expect(artifacts.records[0]).not.toHaveProperty('path');
          expect(artifacts.records[0]).not.toHaveProperty('sha256');
          expect(artifacts.records[0]!.redaction).toBe('incomplete');
        }
      } finally {
        // Baseline failures also drain genuine IO before removing the throwaway project.
        stream?.destroy();
        await new Promise((resolve) => setTimeout(resolve, 150));
        create.mockRestore(); syncClose.mockRestore(); syncBuiltinESMExports();
        if (replacementFD !== undefined && isOpen(replacementFD)) realCloseSync(replacementFD);
      }
    });

    it.each(['construct-throw', 'pre-stream-stat', 'pre-abort', 'expired', 'missing', 'cross-sink'] as const)(
      'closes only locally owned descriptors on %s', async (mode) => {
        const { artifacts } = setup(sdk, false);
        const foreign = mode === 'cross-sink' ? setup(sdk, false).artifacts.sink : artifacts.sink;
        const ticket = sdk.debugEvidenceRegistration(foreign, 'text');
        const controller = new AbortController();
        if (mode === 'pre-abort') controller.abort();
        const realOpen = fs.openSync, realClose = fs.closeSync;
        const opened: number[] = [], closed: number[] = [];
        const open = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
          const fd = realOpen(...args); opened.push(fd); return fd;
        });
        const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => { closed.push(fd); realClose(fd); });
        const create = vi.spyOn(fs, 'createReadStream').mockImplementation(() => { throw new Error('construction failed'); });
        const stat = mode === 'pre-stream-stat' ? vi.spyOn(fs, 'fstatSync').mockImplementation(() => { throw new Error('stat failed'); }) : undefined;
        syncBuiltinESMExports();
        try {
          await sdk.bindDebugEvidenceFile(artifacts.sink, mode === 'missing' ? 'missing.txt' : 'original.txt',
            ticket, controller.signal, mode === 'expired' ? Date.now() - 1 : Infinity);
          expect(closed).toEqual(opened);
          expect(opened).toHaveLength(['construct-throw', 'pre-stream-stat'].includes(mode) ? 1 : 0);
          expect(create).toHaveBeenCalledTimes(mode === 'construct-throw' ? 1 : 0);
          expect(sdk.debugEvidenceProven(artifacts.sink, ticket)).toBe(false);
        } finally {
          open.mockRestore(); close.mockRestore(); create.mockRestore(); stat?.mockRestore(); syncBuiltinESMExports();
        }
        for (const fd of opened) expect(isOpen(fd)).toBe(false);
      },
    );
  });
}
