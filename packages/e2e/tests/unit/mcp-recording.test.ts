import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationContext, VideoSegment } from '../../src/engine/surface.ts';
import { describeRecording, SessionRecorder } from '../../src/mcp/recording.ts';

describe('SessionRecorder', () => {
  let dir: string;
  let attemptDir: string;
  let outDir: string;
  let calls: string[];
  /** What the next stopVideo writes, relative to the attempt directory, and returns. */
  let written: string[];

  const operation = (timeoutMs: number): OperationContext => ({
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
    runId: 'run',
    attemptId: 'attempt',
    origin: 'test',
  });

  /** Engine calls that fail, by name, until the test clears them. */
  let failing: Set<string>;
  let tainted: boolean;

  const recorder = () =>
    new SessionRecorder({
      startVideo: async () => {
        calls.push('start');
        if (failing.has('start')) throw new Error('device refused to record');
      },
      stopVideo: async (): Promise<readonly VideoSegment[]> => {
        calls.push('stop');
        if (failing.has('stop')) throw new Error('device lost the recording');
        return written.map((relative, index) => {
          mkdirSync(path.dirname(path.join(attemptDir, relative)), { recursive: true });
          writeFileSync(path.join(attemptDir, relative), `${calls.length}:${index}`);
          return { path: relative, startedAt: new Date(Date.now() - 2_000).toISOString() };
        });
      },
      attemptDir,
      outDir,
      operation,
      timeoutMs: 1_000,
      tainted: () => tainted,
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-recording-'));
    attemptDir = path.join(dir, 'attempt');
    outDir = path.join(dir, 'recordings', 'session');
    calls = [];
    written = ['video/video.mp4'];
    failing = new Set();
    tainted = false;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves each recording out of the attempt directory, so a second one at the same engine path keeps the first', async () => {
    const recordings = recorder();
    expect(await recordings.start('login')).toBe(
      'Recording 1 "login" started. Act as usual; stop_recording saves the video, and close_session saves one still running.',
    );
    expect(recordings.isRecording).toBe(true);
    const first = await recordings.stop();
    await recordings.start(undefined);
    const second = await recordings.stop();

    expect(first?.files).toEqual([path.join(outDir, '1-login.mp4')]);
    expect(second?.files).toEqual([path.join(outDir, '2.mp4')]);
    expect(readFileSync(first!.files[0]!, 'utf8')).toBe('2:0');
    expect(readFileSync(second!.files[0]!, 'utf8')).toBe('4:0');
    expect(existsSync(path.join(attemptDir, 'video', 'video.mp4'))).toBe(false);
    expect(first!.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(recordings.isRecording).toBe(false);
  });

  it('reports a recording already running instead of restarting it, and a stop with nothing running as undefined', async () => {
    const recordings = recorder();
    expect(await recordings.stop()).toBeUndefined();
    await recordings.start('demo');
    expect(await recordings.start('other')).toMatch(/^Recording 1 "demo" is already running since \S+; stop_recording ends it\.$/);
    expect(calls).toEqual(['start']);
  });

  it('names the later segments of one recording as parts, in play order', async () => {
    written = ['video/video.webm', 'video/video-part2.webm'];
    const recordings = recorder();
    await recordings.start('checkout');
    const recording = await recordings.stop();
    expect(recording?.files).toEqual([path.join(outDir, '1-checkout.webm'), path.join(outDir, '1-checkout-part2.webm')]);
    expect(describeRecording(recording!)).toMatch(
      new RegExp(
        `^Recording 1 "checkout" stopped after \\d+\\.\\d s\\.\\n2 files, one per page the surface showed; they play in this order:\\n- ${outDir.replaceAll(/[\\/.]/g, '\\$&')}/1-checkout\\.webm\\n- .*1-checkout-part2\\.webm$`,
      ),
    );
  });

  it('says so when the engine wrote nothing', async () => {
    written = [];
    const recordings = recorder();
    await recordings.start(undefined);
    const recording = await recordings.stop();
    expect(recording?.files).toEqual([]);
    expect(describeRecording(recording!)).toMatch(/^Recording 1 stopped after \d+\.\d s\.\nThe engine wrote no video: nothing was shown while it ran\.$/);
  });

  it('stops the engine after a failed start, so the next start begins from nothing', async () => {
    const recordings = recorder();
    failing.add('start');
    await expect(recordings.start('demo')).rejects.toThrow('device refused to record');
    expect(recordings.isRecording).toBe(false);
    expect(calls).toEqual(['start', 'stop']);
    failing.clear();
    expect(await recordings.start('demo')).toContain('Recording 1 "demo" started.');
  });

  it('keeps a recording whose stop failed running, so a second stop saves it', async () => {
    const recordings = recorder();
    await recordings.start('demo');
    failing.add('stop');
    await expect(recordings.stop()).rejects.toThrow('device lost the recording');
    expect(recordings.isRecording).toBe(true);
    failing.clear();
    const recording = await recordings.stop();
    expect(recording?.files).toEqual([path.join(outDir, '1-demo.mp4')]);
  });

  it('says so when a secret was filled in the session before the recording stopped', async () => {
    const recordings = recorder();
    await recordings.start(undefined);
    tainted = true;
    const recording = await recordings.stop();
    expect(recording?.tainted).toBe(true);
    expect(describeRecording(recording!)).toMatch(
      /\nA secret was filled in this session and videos are not masked: check it is not on screen before sharing\.$/,
    );
  });
});
