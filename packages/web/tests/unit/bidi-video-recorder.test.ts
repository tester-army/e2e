/**
 * The video's segment bookkeeping over a scripted Firefox peer, whose
 * screencast is plain BiDi: one segment per tab, a failed finish that still
 * left a file kept, a lost segment reported once, and every hook a no-op
 * until armed. The real screencasts are covered by the lifecycle
 * integration test on each browser.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { BidiVideo, type VideoOptions } from '../../src/driver/video.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { FakeBidi, type Reply } from '../helpers/bidi-fake.ts';

const VIEWPORT = { width: 320, height: 200 };

/** How the scripted browser answers one screencast. */
interface ScreencastScript {
  /** Fails the start with this error. */
  readonly startError?: string;
  /** Answers the stop with this error after writing nothing, or after writing the attempt's file itself when `wroteTarget`. */
  readonly stopError?: string;
  readonly wroteTarget?: boolean;
}

describe('BidiVideo', () => {
  let artifactsDir: string;
  let browserDir: string;
  let bidi: FakeBidi;
  /** Scripts keyed by the context a screencast records; a context with none records cleanly. */
  let scripts: Map<string, ScreencastScript>;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-unit-'));
    browserDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-browser-'));
    scripts = new Map();
    bidi = new FakeBidi()
      .on('browsingContext.startScreencast', (params) => {
        const context = params['context'] as string;
        const script = scripts.get(context) ?? {};
        if (script.startError !== undefined) return { error: 'unknown error', message: script.startError };
        return { result: { screencast: `cast-${context}` } };
      })
      .on('browsingContext.stopScreencast', (params): Reply => {
        const context = (params['screencast'] as string).replace(/^cast-/, '');
        const script = scripts.get(context) ?? {};
        if (script.stopError !== undefined) {
          if (script.wroteTarget === true) writeFileSync(path.join(artifactsDir, 'video', targetName(context)), 'webm');
          return { result: { error: script.stopError } };
        }
        const file = path.join(browserDir, `${context}.webm`);
        writeFileSync(file, 'webm');
        return { result: { path: file } };
      });
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(browserDir, { recursive: true, force: true });
  });

  /** The segment file name the test expects `context` to be recorded as, by the order the tests open contexts in. */
  function targetName(context: string): string {
    const index = Number(context.replace(/^tab-/, ''));
    return index === 1 ? 'video.webm' : `video-part${String(index)}.webm`;
  }

  const video = (options: VideoOptions = {}) => new BidiVideo(bidi.connection, BROWSER_TRAITS.firefox, artifactsDir, options, {});
  const started = () => bidi.commands('browsingContext.startScreencast').map((command) => command.params);
  const stops = () => bidi.commands('browsingContext.stopScreencast').length;
  const paths = (segments: readonly { path: string }[]) => segments.map((segment) => segment.path);

  it('records one segment per tab, in order, each at its viewport and with its start instant', async () => {
    const recorder = video();
    await recorder.arm('tab-1', VIEWPORT);
    // A restart ends the segment before its tab closes, then opens another tab: the next segment.
    await recorder.contextClosing();
    expect(stops()).toBe(1);
    await recorder.contextOpened('tab-2', { width: 390, height: 600 });
    expect(started()).toEqual([
      { context: 'tab-1', mimeType: 'video/webm', video: { ...VIEWPORT, frameRate: 25 } },
      { context: 'tab-2', mimeType: 'video/webm', video: { width: 390, height: 600, frameRate: 25 } },
    ]);
    const segments = await recorder.stop();
    expect(paths(segments)).toEqual(['video/video.webm', 'video/video-part2.webm']);
    for (const segment of segments) {
      expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
      expect(existsSync(path.join(artifactsDir, segment.path))).toBe(true);
    }
    expect(stops()).toBe(2);
    expect(existsSync(path.join(browserDir, 'tab-1.webm'))).toBe(false);
  });

  it('records at the configured size instead of the viewport when given', async () => {
    const recorder = video({ size: { width: 640, height: 400 } });
    await recorder.arm('tab-1', VIEWPORT);
    expect(started()[0]).toMatchObject({ video: { width: 640, height: 400 } });
    await recorder.stop();
  });

  it('starts again after a stop on the same tab, and the second stop hands over only the new segment', async () => {
    const recorder = video();
    await recorder.arm('tab-1', VIEWPORT);
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
    // Disarmed between recordings: a tab opened now starts nothing.
    await recorder.contextOpened('tab-9', VIEWPORT);
    expect(started()).toHaveLength(1);
    await recorder.arm('tab-2', VIEWPORT);
    expect(paths(await recorder.stop())).toEqual(['video/video-part2.webm']);
  });

  it('keeps a segment whose finish failed but whose file exists', async () => {
    scripts.set('tab-1', { stopError: 'encoder stalled', wroteTarget: true });
    const recorder = video();
    await recorder.arm('tab-1', VIEWPORT);
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
  });

  it('reports a segment whose finish failed and left no file, once', async () => {
    scripts.set('tab-1', { stopError: 'screencast stop failed' });
    const recorder = video();
    await recorder.arm('tab-1', VIEWPORT);
    const caught = await recorder.stop().then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('video/video.webm') });
    expect((caught as Error).message).toContain('screencast stop failed');
    // Reported, then forgotten: the next stop has nothing to say.
    expect(await recorder.stop()).toEqual([]);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
  });

  it('hands the segments that finalized to the stop after one that reported a lost segment', async () => {
    scripts.set('tab-2', { stopError: 'screencast stop failed' });
    const recorder = video();
    await recorder.arm('tab-1', VIEWPORT);
    await recorder.contextOpened('tab-2', VIEWPORT);
    await expect(recorder.stop()).rejects.toThrow('video/video-part2.webm');
    // A host that retries the stop gets what did finalize, so nothing on disk goes unreported.
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
  });

  it('stays disarmed when the first segment cannot start, so a later tab does not record', async () => {
    scripts.set('tab-1', { startError: 'screencast unavailable' });
    const recorder = video();
    await expect(recorder.arm('tab-1', VIEWPORT)).rejects.toThrow('screencast unavailable');
    await recorder.contextOpened('tab-2', VIEWPORT);
    expect(started()).toHaveLength(1);
    expect(await recorder.stop()).toEqual([]);
    expect(stops()).toBe(0);
  });

  it('ends at once a segment whose start outlived the stop', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    bidi.on('browsingContext.startScreencast', async () => {
      await held;
      return { result: { screencast: 'cast-tab-1' } };
    });
    const recorder = video();
    const arming = recorder.arm('tab-1', VIEWPORT);
    const stopping = recorder.stop();
    release();
    await arming;
    // The start finished after the stop began, so its segment ended at once and the stop hands it over.
    expect(paths(await stopping)).toEqual(['video/video.webm']);
    expect(stops()).toBe(1);
    await recorder.contextOpened('tab-2', VIEWPORT);
    expect(started()).toHaveLength(1);
  });

  it('runs every hook straight through until armed', async () => {
    const recorder = video();
    await recorder.contextOpened('tab-1', VIEWPORT);
    await recorder.contextClosing();
    expect(await recorder.stop()).toEqual([]);
    expect(bidi.sent).toEqual([]);
  });
});
