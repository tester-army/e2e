/** Evidence on the BiDi driver: masked screenshots and the attempt's video. */

import { writeFileSync } from 'node:fs';
import type { VideoSegment } from 'e2e/engine';
import { ProviderVideo } from '../provider-video.ts';
import type { LeaseRecording } from '../provider.ts';
import { releaseQuietly } from './errors.ts';
import { maskedPixels } from './observe.ts';
import type { BidiSession } from './session.ts';
import { BidiVideo } from './video.ts';

/** The viewport a video starts at before any tab exists: the configured one, else Playwright's default. */
const DEFAULT_VIDEO_SIZE = { width: 1280, height: 720 };

/** Writes a masked viewport screenshot under the attempt directory and returns its relative path. */
export async function screenshot(session: BidiSession, label: string | undefined): Promise<string> {
  const { relative, absolute } = session.artifactPath('screenshots', label, '.png');
  const { pixels } = await maskedPixels(session, await session.viewportSize());
  writeFileSync(absolute, pixels.data);
  return relative;
}

/**
 * Starts the attempt's video: the provider's recording of the browser when
 * `recorder` is given, else the open tab now and every tab the attempt opens
 * until it stops. A start that finishes after `signal` aborted is stopped
 * again, so no recording outlives the step that gave up on it.
 */
export async function startVideo(session: BidiSession, recorder: ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined, signal: AbortSignal): Promise<void> {
  if (recorder !== undefined) {
    session.providerVideo ??= new ProviderVideo(recorder, session.attempt.artifactsDir);
    await session.providerVideo.arm(signal);
    return;
  }
  session.video ??= new BidiVideo(session.connection, session.settings.browser, session.attempt.artifactsDir, session.settings.screencast);
  const size = session.context === undefined ? (session.settings.viewport ?? DEFAULT_VIDEO_SIZE) : await session.viewportSize();
  await session.video.arm(session.context, size);
  if (signal.aborted) {
    await releaseQuietly(session.video.stop());
    signal.throwIfAborted();
  }
}

/** Finishes the attempt's recording and returns its segments. */
export async function stopVideo(session: BidiSession, signal: AbortSignal): Promise<readonly VideoSegment[]> {
  if (session.providerVideo !== undefined) return session.providerVideo.stop(signal);
  return (await session.video?.stop()) ?? [];
}
