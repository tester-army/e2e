/** Buffered native uploads retain selected bytes without an unbounded filesystem read. */

import { mkdtemp, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareUploadFiles } from '../../src/upload-files.ts';
import { web } from '../../src/index.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import type { Page } from 'playwright-core';
import type { ActionTarget } from '../../src/support.ts';

const hooks = vi.hoisted(() => ({ reads: 0, requestedLengths: [] as number[], afterRead: undefined as (() => Promise<void>) | undefined, afterClose: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof read>) => {
      const [buffer, offset, length] = readArgs as unknown as [Buffer, number, number, number];
      expect(buffer.byteLength).toBeLessThanOrEqual(2_000_001);
      expect(length).toBeLessThanOrEqual(2_000_001);
      expect(length).toBeLessThanOrEqual(buffer.byteLength - offset);
      hooks.requestedLengths.push(length);
      hooks.reads++;
      const result = await read(...readArgs);
      const hook = hooks.afterRead;
      hooks.afterRead = undefined;
      await hook?.();
      return result;
    }) as typeof handle.read;
    handle.close = async () => { await close(); await hooks.afterClose?.(); };
    return handle;
  } };
});

describe('buffered file uploads', () => {
  let directory: string;
  const operation = (signal = new AbortController().signal) => ({ signal, timeoutMs: 2_000 });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'buffered-upload-'));
    hooks.reads = 0; hooks.requestedLengths = []; hooks.afterRead = undefined; hooks.afterClose = undefined;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = async (name = 'contract.pdf', bytes: Buffer | string = '%PDF-1.7\nFICTIONAL\0\xff') => {
    const selected = path.join(directory, name);
    await writeFile(selected, bytes);
    return selected;
  };

  it('keeps the default/path transport byte-for-byte, without reading even nonexistent paths', async () => {
    const paths = ['/not-present/large.pdf'];
    expect(await prepareUploadFiles(paths, 'path', operation())).toEqual(paths);
    expect(hooks.reads).toBe(0);
    expect(() => web({ fileUploads: 'path' })).not.toThrow();
    expect(() => web({ fileUploads: 'buffered' })).not.toThrow();
    expect(() => web({ fileUploads: 'unknown' as 'buffered' })).toThrow(/fileUploads/);
  });

  it('uses actual selected bytes, basename and normal MIME lookup, including binary PDF bytes', async () => {
    const bytes = Buffer.from([37, 80, 68, 70, 45, 49, 0, 255, 128]);
    const selected = await file('contract.PDF', bytes), text = await file('notes.txt', 'fictional notes');
    expect(await prepareUploadFiles([selected, text], 'buffered', operation())).toEqual([
      { name: 'contract.PDF', mimeType: 'application/pdf', buffer: bytes },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('fictional notes') },
    ]);
  });

  it('accepts the exact aggregate byte bound and refuses larger files before reading', async () => {
    const bytes = Buffer.alloc(2_000_000); bytes.write('%PDF-');
    const selected = await file('exact.pdf', bytes);
    expect((await prepareUploadFiles([selected], 'buffered', operation()))[0]).toMatchObject({ buffer: bytes });
    expect(Math.max(...hooks.requestedLengths)).toBe(2_000_001);
    await writeFile(selected, Buffer.alloc(2_000_001)); hooks.reads = 0;
    await expect(prepareUploadFiles([selected], 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(hooks.reads).toBe(0);
  });

  it('bounds aggregate bytes and file count rather than only each individual file', async () => {
    const a = await file('a.txt', Buffer.alloc(1_100_000)), b = await file('b.txt', Buffer.alloc(1_100_000));
    await expect(prepareUploadFiles([a, b], 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    hooks.reads = 0;
    await expect(prepareUploadFiles(Array(33).fill(a), 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(hooks.reads).toBe(0);
  });

  it('refuses directories, symlinks and false PDF extensions before native dispatch', async () => {
    const selected = await file(), link = path.join(directory, 'link.pdf'); await symlink(selected, link);
    for (const candidate of [directory, link, await file('not-a-pdf.pdf', 'text')]) {
      await expect(prepareUploadFiles([candidate], 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    }
  });

  it('refuses a file changed while its bounded handle is being read', async () => {
    const selected = await file();
    hooks.afterRead = () => writeFile(selected, 'CHANGED');
    await expect(prepareUploadFiles([selected], 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('refuses a pathname replaced while the selected handle is being read', async () => {
    const selected = await file();
    hooks.afterRead = async () => { await rename(selected, `${selected}.old`); await writeFile(selected, '%PDF-OTHER'); };
    await expect(prepareUploadFiles([selected], 'buffered', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('never publishes buffered files after cancellation during a read', async () => {
    const selected = await file(), controller = new AbortController();
    hooks.afterRead = async () => { controller.abort(); };
    await expect(prepareUploadFiles([selected], 'buffered', operation(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rechecks cancellation after asynchronous handle cleanup', async () => {
    const selected = await file(), controller = new AbortController();
    hooks.afterClose = async () => { controller.abort(); };
    await expect(prepareUploadFiles([selected], 'buffered', operation(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  /** Keeps real preparation/outer deadline code, replacing only native protocol calls. */
  const boundary = (native: () => Promise<void>) => {
    const surface = new PlaywrightSurface({ fileUploads: 'buffered' });
    const target = { kind: 'locator', locator: { setInputFiles: native, click: native } } as unknown as ActionTarget;
    vi.spyOn(surface, 'requirePage').mockReturnValue({} as Page);
    vi.spyOn(surface as unknown as { requireSession(): { refs: { lookup(): ActionTarget } } }, 'requireSession').mockReturnValue({ refs: { lookup: () => target } });
    return surface;
  };
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const phaseOperation = (signal = new AbortController().signal) => ({ signal, timeoutMs: 1_000, runId: 'phase', attemptId: 'phase', origin: 'test' as const });

  it('classifies a real file-close preparation timeout as definitely not dispatched', async () => {
    const selected = await file(), closing = gate(), entered = gate();
    hooks.afterClose = async () => { entered.resolve(); await closing.promise; };
    const native = vi.fn(async () => undefined), surface = boundary(native);
    vi.useFakeTimers();
    try {
      const writing = surface.perform({ id: 'file', revision: '1' }, { kind: 'setInputFiles', paths: [selected] }, phaseOperation()).then(() => undefined, cause => cause);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await writing).toMatchObject({ code: 'NOT_ACTIONABLE' });
      closing.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(native).not.toHaveBeenCalled();
    } finally { closing.resolve(); vi.useRealTimers(); }
  });

  it('cancels during real preparation cleanup without dispatch, including a late response', async () => {
    const selected = await file(), closing = gate(), entered = gate(), controller = new AbortController();
    hooks.afterClose = async () => { entered.resolve(); await closing.promise; };
    const native = vi.fn(async () => undefined), surface = boundary(native);
    const writing = expect(surface.perform({ id: 'file', revision: '1' }, { kind: 'setInputFiles', paths: [selected] }, phaseOperation(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await entered.promise; controller.abort(); await writing;
      closing.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(native).not.toHaveBeenCalled();
    } finally { closing.resolve(); }
  });

  it('retains possibly-committed classification once the actual native protocol call starts', async () => {
    const selected = await file(), hanging = gate(), entered = gate();
    const native = vi.fn(async () => { entered.resolve(); await hanging.promise; }), surface = boundary(native);
    vi.useFakeTimers();
    try {
      const writing = expect(surface.perform({ id: 'file', revision: '1' }, { kind: 'setInputFiles', paths: [selected] }, phaseOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); await writing;
      expect(native).toHaveBeenCalledTimes(1);
    } finally { hanging.resolve(); vi.useRealTimers(); }
  });

  it('leaves non-upload uncertain input classification unchanged', async () => {
    const hanging = gate(), entered = gate();
    const native = vi.fn(async () => { entered.resolve(); await hanging.promise; }), surface = boundary(native);
    vi.useFakeTimers();
    try {
      const writing = expect(surface.perform({ id: 'button', revision: '1' }, { kind: 'tap' }, phaseOperation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      await entered.promise; await vi.advanceTimersByTimeAsync(1_000); await writing;
      expect(native).toHaveBeenCalledTimes(1);
    } finally { hanging.resolve(); vi.useRealTimers(); }
  });
});
