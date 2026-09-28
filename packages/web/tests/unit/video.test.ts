/**
 * The recorder's segment bookkeeping over a scripted page: one segment per
 * page, a failed stop that still left a file kept, a lost segment reported at
 * stop without carrying the rest into the next recording, and every hook a
 * no-op until armed. The real screencast is covered by
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
function fakePage(options: { writes?: boolean; stopError?: Error; startError?: Error } = {}) {
  const started: string[] = [];
  const page = {
    screencast: {
      start: async ({ path: file }: { path: string }) => {
        if (options.startError !== undefined) throw options.startError;
        started.push(file);
        if (options.writes !== false) writeFileSync(file, 'webm');
      },
      stop: async () => {
        if (options.stopError !== undefined) throw options.stopError;
      },
    },
  } as unknown as Page;
  return { page, started };
}

describe('VideoRecorder', () => {
  let dir: string;
  const recorder = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-video-unit-'));
    return new VideoRecorder(VIEWPORT, dir);
  };
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records one segment per page, in order, each with its start instant', async () => {
    const video = recorder();
    const first = fakePage();
    const second = fakePage();
    await video.arm(first.page);
    expect(video.isArmed).toBe(true);
    expect(video.isRecording).toBe(true);
    expect(first.started).toEqual([path.join(dir, 'video', 'video.webm')]);
    // A restart ends the segment before its page closes, then opens another page: the next segment.
    await video.pageClosing();
    expect(video.isRecording).toBe(false);
    expect(video.isArmed).toBe(true);
    await video.pageOpened(second.page);
    expect(second.started).toEqual([path.join(dir, 'video', 'video-part2.webm')]);
    const segments = await video.stop();
    expect(segments.map((segment) => segment.path)).toEqual(['video/video.webm', 'video/video-part2.webm']);
    for (const segment of segments) expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
    expect(video.isArmed).toBe(false);
    expect(video.isRecording).toBe(false);
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

  it('drops the finalized segments of a stop that reported a lost one, so the next recording starts empty', async () => {
    const video = recorder();
    const kept = fakePage();
    const broken = fakePage({ writes: false, stopError: new Error('screencast stop failed') });
    await video.arm(kept.page);
    await video.pageClosing();
    await video.pageOpened(broken.page);
    await expect(video.stop()).rejects.toThrow('video/video-part2.webm');
    // The segment that finalized stays on disk, but belongs to the failed recording, not the next one.
    expect(existsSync(path.join(dir, 'video', 'video.webm'))).toBe(true);
    const next = fakePage();
    await video.arm(next.page);
    expect((await video.stop()).map((segment) => segment.path)).toEqual(['video/video-part3.webm']);
  });

  it('stays disarmed when the first segment cannot start', async () => {
    const video = recorder();
    const dead = fakePage({ startError: new Error('screencast unavailable') });
    await expect(video.arm(dead.page)).rejects.toThrow('screencast unavailable');
    expect(video.isArmed).toBe(false);
    expect(video.isRecording).toBe(false);
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
