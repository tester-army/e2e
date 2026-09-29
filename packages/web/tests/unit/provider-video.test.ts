/** `ProviderVideo`: the attempt's video as the browser provider records it, through starts that outlive their budget and stops that fail. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRecording } from 'e2e/engine';
import { ProviderVideo } from '../../src/provider-video.ts';
import type { LeaseRecording } from '../../src/provider.ts';

const PAGE = {} as Page;

describe('ProviderVideo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const artifactsDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-video-'));
    dirs.push(dir);
    return dir;
  };

  /** A recording named `name` whose stop writes `<name>.mp4`, failing the first `failures` stops. */
  const recording = (name: string, stopped: string[], failures = 0): LeaseRecording => {
    let left = failures;
    const provided: ProviderRecording = {
      startedAt: '2026-09-28T10:00:00.000Z',
      async stop({ dir }) {
        stopped.push(name);
        if (left-- > 0) throw new Error('recorder unreachable');
        writeFileSync(path.join(dir, `${name}.mp4`), 'mp4');
        return { file: `${name}.mp4` };
      },
    };
    return { recording: provided, provider: 'browser provider "cloud"', leaseId: 'lease-0' };
  };

  it('stops a start that landed after its budget ran out, and keeps the recording started after it', async () => {
    const stopped: string[] = [];
    let land!: (started: LeaseRecording) => void;
    const starts = [
      () => new Promise<LeaseRecording>((resolve) => { land = resolve; }),
      async () => recording('second', stopped),
    ];
    const video = new ProviderVideo(async () => starts.shift()!(), artifactsDir());
    const timedOut = new AbortController();
    const first = video.arm(PAGE, timedOut.signal);
    timedOut.abort();
    await video.arm(PAGE, new AbortController().signal);
    land(recording('first', stopped));
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stopped).toEqual(['first']);
    expect((await video.stop(new AbortController().signal)).map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/second.mp4']);
  });

  it('keeps the handle of a recording whose stop failed on abandon, so a later stop still ends it', async () => {
    const stopped: string[] = [];
    const video = new ProviderVideo(async () => recording('clip', stopped, 1), artifactsDir());
    await video.arm(PAGE, new AbortController().signal);
    await video.abandon(new AbortController().signal);
    expect(stopped).toEqual(['clip']);
    expect(await video.stop(new AbortController().signal)).toHaveLength(1);
    expect(stopped).toEqual(['clip', 'clip']);
  });
});
