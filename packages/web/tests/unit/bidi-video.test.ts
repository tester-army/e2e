/**
 * The BiDi recorder's policy without a real browser: a segment that cannot
 * start never fails the tab that opened, `stop` reports it once, and a
 * recorder whose own start failed stays disarmed.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BidiVideo } from '../../src/driver/video.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const VIEWPORT = { width: 320, height: 240 };

/** A Chromium recorder on `fake` whose CDP session never opens, with an ffmpeg that is never reached. */
function recorder(fake: FakeBidi): BidiVideo {
  fake.on('goog:cdp.getSession', { error: 'unknown error', message: 'no CDP session for this tab' });
  return new BidiVideo(fake.connection, BROWSER_TRAITS.chromium, mkdtempSync(path.join(os.tmpdir(), 'e2e-video-test-')), {}, { E2E_FFMPEG_PATH: process.execPath });
}

describe('BidiVideo', () => {
  it('lets a tab open when its segment cannot start, and reports the lost segment from stop once', async () => {
    const video = recorder(new FakeBidi());
    await video.arm(undefined, VIEWPORT);
    await expect(video.contextOpened('tab', VIEWPORT)).resolves.toBeUndefined();
    await expect(video.stop()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('no CDP session for this tab') });
    await expect(video.stop()).resolves.toEqual([]);
  });

  it('stays disarmed after its own start failed, so later tabs start no segment', async () => {
    const fake = new FakeBidi();
    const video = recorder(fake);
    await expect(video.arm('tab', VIEWPORT)).rejects.toThrow('no CDP session for this tab');
    const tried = fake.commands('goog:cdp.getSession').length;
    await video.contextOpened('tab-2', VIEWPORT);
    expect(fake.commands('goog:cdp.getSession')).toHaveLength(tried);
    await expect(video.stop()).resolves.toEqual([]);
  });
});
