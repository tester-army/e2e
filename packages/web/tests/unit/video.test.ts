/**
 * The recorder's segment bookkeeping over a scripted page: one segment per
 * page, a failed stop that still left a file kept, a lost segment reported at
 * stop, and every hook a no-op until armed. The real screencast is covered by
 * the lifecycle integration test.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { VideoRecorder } from '../../src/video.ts';

const VIEWPORT = { width: 320, height: 200 };

/** A page whose screencast writes its file on start unless told not to, and fails to stop when told to. */
function fakePage(options: { writes?: boolean; stopError?: Error; startError?: Error; viewport?: { width: number; height: number } } = {}) {
  const started: string[] = [];
  const sizes: { width: number; height: number }[] = [];
  const startOptions: Record<string, unknown>[] = [];
  const stopped = { count: 0 };
  const page = {
    viewportSize: () => options.viewport ?? VIEWPORT,
    screencast: {
      start: async (start: { path: string; size: { width: number; height: number } }) => {
        const { path: file, size } = start;
        if (options.startError !== undefined) throw options.startError;
        started.push(file);
        sizes.push(size);
        startOptions.push({ ...start });
        if (options.writes !== false) writeFileSync(file, 'webm');
      },
      stop: async () => {
        stopped.count += 1;
        if (options.stopError !== undefined) throw options.stopError;
      },
    },
  } as unknown as Page;
  return { page, started, sizes, startOptions, stopped };
}

describe('VideoRecorder', () => {
  let dir: string;
  const recorder = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-video-unit-'));
    return new VideoRecorder(dir);
  };
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records one segment per page, in order, each with its start instant', async () => {
    const video = recorder();
    const first = fakePage();
    const second = fakePage({ viewport: { width: 390, height: 600 } });
    await video.arm(first.page);
    expect(video.isArmed).toBe(true);
    expect(first.started).toEqual([path.join(dir, 'video', 'video.webm')]);
    // A restart ends the segment before its page closes, then opens another page: the next segment.
    await video.pageClosing();
    expect(first.stopped.count).toBe(1);
    expect(video.isArmed).toBe(true);
    await video.pageOpened(second.page);
    expect(second.started).toEqual([path.join(dir, 'video', 'video-part2.webm')]);
    expect([...first.sizes, ...second.sizes]).toEqual([VIEWPORT, { width: 390, height: 600 }]);
    const segments = await video.stop();
    expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm']);
    for (const segment of segments) expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
    expect(video.isArmed).toBe(false);
    expect([first.stopped.count, second.stopped.count]).toEqual([1, 1]);
  });

  it('records at the viewport size by default, and at the configured size and quality when given', async () => {
    const plain = fakePage();
    await recorder().arm(plain.page);
    expect(plain.startOptions[0]).toMatchObject({ size: VIEWPORT });
    expect(plain.startOptions[0]).not.toHaveProperty('quality');
    const tuned = fakePage();
    const dirTuned = mkdtempSync(path.join(tmpdir(), 'e2e-video-unit-'));
    try {
      await new VideoRecorder(dirTuned, { size: { width: 640, height: 400 }, quality: 70 }).arm(tuned.page);
      expect(tuned.startOptions[0]).toMatchObject({ size: { width: 640, height: 400 }, quality: 70 });
    } finally {
      rmSync(dirTuned, { recursive: true, force: true });
    }
  });

  it('keeps a segment whose stop failed but whose file exists', async () => {
    const video = recorder();
    const flaky = fakePage({ stopError: new Error('screencast.stop: protocol error') });
    await video.arm(flaky.page);
    expect((await video.stop()).map((segment) => segment.path)).toEqual(['video/video.webm']);
  });

  it('reports a segment whose stop failed and left no file, once', async () => {
    const video = recorder();
    const broken = fakePage({ writes: false, stopError: new Error('screencast stop failed') });
    await video.arm(broken.page);
    let caught: unknown;
    try {
      await video.stop();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(String((caught as Error).message)).toContain('video/video.webm');
    expect(String((caught as Error).message)).toContain('screencast stop failed');
    expect(video.isArmed).toBe(false);
    // Reported, then forgotten: the next stop has nothing to say.
    expect(await video.stop()).toEqual([]);
    expect(existsSync(path.join(dir, 'video', 'video.webm'))).toBe(false);
  });

  it('hands the segments that finalized to the stop after one that reported a lost segment', async () => {
    const video = recorder();
    const kept = fakePage();
    const broken = fakePage({ writes: false, stopError: new Error('screencast stop failed') });
    await video.arm(kept.page);
    await video.pageClosing();
    await video.pageOpened(broken.page);
    await expect(video.stop()).rejects.toThrow('video/video-part2.webm');
    // A host that retries the stop gets what did finalize, so nothing on disk goes unreported.
    expect((await video.stop()).map((segment) => segment.path)).toEqual(['video/video.webm']);
  });

  it('starts no segment for a page opened after the attempt abandoned its recording', async () => {
    const video = recorder();
    const first = fakePage();
    const late = fakePage();
    await video.arm(first.page);
    await video.abandon();
    expect(video.isArmed).toBe(false);
    await video.pageOpened(late.page);
    expect(late.started).toEqual([]);
  });

  it('stays disarmed when the first segment cannot start', async () => {
    const video = recorder();
    const dead = fakePage({ startError: new Error('screencast unavailable') });
    await expect(video.arm(dead.page)).rejects.toThrow('screencast unavailable');
    expect(video.isArmed).toBe(false);
    expect(await video.stop()).toEqual([]);
    expect(dead.stopped.count).toBe(0);
  });

  it('runs every hook straight through until armed', async () => {
    const video = recorder();
    const idle = fakePage();
    await video.pageOpened(idle.page);
    expect(idle.started).toEqual([]);
    await video.pageClosing();
    expect(await video.stop()).toEqual([]);
  });
});
