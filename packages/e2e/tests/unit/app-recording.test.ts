/**
 * `app.startRecording` / `app.stopRecording` over the engine's one recorder:
 * spans moved into `recordings/`, the attempt's video and a span never share
 * it, and a failed start leaves nothing held.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationContext, TargetSession, VideoSegment } from '../../src/engine/surface.ts';
import { sessionRecordings } from '../../src/run/recordings.ts';
import type { ArtifactSink } from '../../src/run/fixtures.ts';

const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 1_000, runId: 'run', attemptId: 'attempt', origin: 'test' };

describe('app recordings', () => {
  let dir: string;
  let calls: string[];
  /** What the next stopVideo writes into the attempt directory and returns; an https URL is a provider's link. */
  let written: string[];
  let failStart: boolean;
  let registered: { kind: string; path: string; startedAt: string | undefined }[];
  let linked: string[];

  const session = (video = true) =>
    ({
      artifacts: {
        screenshot: async () => 'screenshots/001.png',
        ...(video
          ? {
              startVideo: async () => {
                calls.push('start');
                if (failStart) throw new Error('device refused to record');
              },
              stopVideo: async (): Promise<readonly VideoSegment[]> => {
                calls.push('stop');
                return written.map((relative) => {
                  if (relative.startsWith('https://')) return { url: relative, mediaType: 'video/mp4', startedAt: '2026-10-27T10:00:00.000Z' };
                  mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
                  writeFileSync(path.join(dir, relative), `${String(calls.length)}`);
                  return { path: relative, startedAt: '2026-10-27T10:00:00.000Z' };
                });
              },
            }
          : {}),
      },
    }) as unknown as TargetSession;

  const sink = (): ArtifactSink => ({
    dir,
    register: (kind, relative, options) => {
      registered.push({ kind, path: relative, startedAt: options?.startedAt });
      return `artifact-${String(registered.length)}`;
    },
    link: (url) => {
      linked.push(url);
      return `link-${String(linked.length)}`;
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-app-recording-'));
    calls = [];
    written = ['video/video.webm'];
    failStart = false;
    registered = [];
    linked = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves each span into recordings/, numbered per session, and returns absolute paths', async () => {
    const recordings = sessionRecordings(session(), 'web');
    await recordings.startSpan('dialog opens', operation);
    expect(recordings.spanRunning).toBe(true);
    const first = await recordings.stopSpan(operation, sink());
    expect(first.videos).toEqual([{ path: path.join(dir, 'recordings', '001-dialog_opens.webm'), startedAt: '2026-10-27T10:00:00.000Z' }]);
    expect(existsSync(path.join(dir, 'video', 'video.webm'))).toBe(false);

    written = ['video/video-part2.webm', 'video/video-part3.webm'];
    await recordings.startSpan(undefined, operation);
    const second = await recordings.stopSpan(operation, sink());
    expect(second.videos.map((video) => ('path' in video ? path.relative(dir, video.path) : video.url))).toEqual([
      path.join('recordings', '002-recording.webm'),
      path.join('recordings', '002-recording-part2.webm'),
    ]);
    expect(second.ids).toEqual(['artifact-2', 'artifact-3']);
    expect(registered.map((artifact) => artifact.kind)).toEqual(['video', 'video', 'video']);
    expect(readFileSync(path.join(dir, 'recordings', '001-dialog_opens.webm'), 'utf8')).toBe('2');
    expect(calls).toEqual(['start', 'stop', 'start', 'stop']);
    expect(recordings.spanRunning).toBe(false);
  });

  it('returns a provider link as a url and registers it as a link', async () => {
    written = ['https://videos.example.com/lease/1.mp4'];
    const recordings = sessionRecordings(session(), 'web');
    await recordings.startSpan('hosted', operation);
    const { videos, ids } = await recordings.stopSpan(operation, sink());
    expect(videos).toEqual([{ url: 'https://videos.example.com/lease/1.mp4', mediaType: 'video/mp4', startedAt: '2026-10-27T10:00:00.000Z' }]);
    expect(ids).toEqual(['link-1']);
    expect(registered).toEqual([]);
  });

  it("refuses a span while the attempt's video holds the recorder, and leaves the attempt's video alone", async () => {
    const recordings = sessionRecordings(session(), 'web');
    await recordings.startAttemptVideo(operation);
    await expect(recordings.startSpan('x', operation)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining("video: 'off'"),
    });
    await expect(recordings.stopSpan(operation, sink())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toEqual(['start']);
    expect(await recordings.stopAttemptVideo(operation)).toEqual([{ path: 'video/video.webm', startedAt: '2026-10-27T10:00:00.000Z' }]);
    await recordings.startSpan('after', operation);
    expect(calls).toEqual(['start', 'stop', 'start']);
  });

  it('refuses a second span and a stop with nothing running', async () => {
    const recordings = sessionRecordings(session(), 'web');
    await expect(recordings.stopSpan(operation, sink())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('app.startRecording()') });
    await recordings.startSpan('one', operation);
    await expect(recordings.startSpan('two', operation)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('already running') });
    expect(calls).toEqual(['start']);
  });

  it('refuses on an engine without video', async () => {
    await expect(sessionRecordings(session(false), 'phone').startSpan('x', operation)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('target "phone"'),
    });
  });

  it('stops a start that failed, so the next start begins from nothing', async () => {
    const recordings = sessionRecordings(session(), 'web');
    failStart = true;
    await expect(recordings.startSpan('x', operation)).rejects.toThrow('device refused to record');
    expect(recordings.spanRunning).toBe(false);
    expect(calls).toEqual(['start', 'stop']);
    failStart = false;
    await recordings.startSpan('y', operation);
    const { videos } = await recordings.stopSpan(operation, sink());
    expect('path' in videos[0] && path.basename(videos[0].path)).toBe('001-y.webm');
  });

  it('fails a stop whose engine wrote no video', async () => {
    written = [];
    const recordings = sessionRecordings(session(), 'web');
    await recordings.startSpan(undefined, operation);
    await expect(recordings.stopSpan(operation, sink())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(recordings.spanRunning).toBe(false);
  });
});
